/**
 * Whole-tx gates and client proving time of a 1-note `transfer_private` against the stock
 * aztec-standards Token's `transfer_private_to_private`, in one run, on one proving wallet.
 *
 *   prove.ts   boot a local network, measure, write bench/proving.json; exit 1 on a missed budget
 *
 * Each row is one gate profile plus a warm-up and five proofs, none sent. "Reused" sends to a
 * recipient whose handshake with the sender already landed, the steady state and the budget;
 * "first contact" sends to a fresh address each time, opening a handshake (informational). The two
 * tokens' proofs alternate, so load that changes during the run weighs on both sides alike.
 */
import { writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { toWord, utf8, wordToNoirString } from "@pp/bridge-core"
import {
	assertNothingLeft,
	connectL2,
	connectPeer,
	createActor,
	freshActorSecret,
	settled,
	startLocalNetwork,
} from "@pp/bridge-core/sandbox"
import { prove } from "../test/net/internals"
import { deployRegistry, tree } from "../test/net/registry"
import { attach, balance, type Device, deployOpts, deployStage, resultOf, sendOpts } from "../test/net/token"

const SAMPLES = 5
const GATE_MARGIN = 60_000
const PROVING_RATIO = 1.5
const L = 0x1abe1n
const K = 0x2abe1n
const POOL = tree([L, K])
const BIRTH = tree([0xb1abe1n])

interface Row {
	gates: number
	provingMs: { median: number; samples: number[] }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number

type Call = (i: number) => ContractFunctionInteraction

async function wholeTxGates(d: Device, call: ContractFunctionInteraction): Promise<number> {
	const profile = (await call.profile({ profileMode: "gates", from: d.from, fee: d.fee } as never)) as {
		executionSteps: { gateCount?: number }[]
	}
	return profile.executionSteps.reduce((sum, s) => sum + (s.gateCount ?? 0), 0)
}

/** One row per call: its gates, a warm-up proof each, then `SAMPLES` rounds proving every call in turn. */
async function measure(d: Device, calls: Call[]): Promise<Row[]> {
	const gates: number[] = []
	for (const call of calls) gates.push(await wholeTxGates(d, call(0)))
	for (const call of calls) await prove(d, call(0))
	const samples = calls.map((): number[] => [])
	for (let i = 1; i <= SAMPLES; i++) {
		for (const [j, call] of calls.entries()) samples[j]?.push(Math.round((await prove(d, call(i))).provingMs))
	}
	return calls.map((_, j) => {
		const xs = samples[j] ?? []
		return { gates: gates[j] ?? 0, provingMs: { median: median(xs), samples: xs } }
	})
}

async function bench(nodeUrl: string) {
	const base = await connectL2(nodeUrl)
	const minter = { wallet: base.wallet, from: base.relayer, fee: base.fee }
	const registry = await deployRegistry(minter, base.node)
	const deployed = await deployStage(minter, registry.address)
	const word = (s: string) => wordToNoirString(toWord(utf8(s)))
	const stockDeploy = await Contract.deploy(
		base.wallet,
		TokenContractArtifact,
		[word("Stock USD"), word("sUSD"), 6, base.relayer, AztecAddress.ZERO],
		"constructor_with_minter",
	).send(deployOpts(minter) as never)

	const peer = await connectPeer(nodeUrl, undefined, true)
	const actor = await createActor(peer.wallet, base.node, peer.fee, freshActorSecret())
	const sender: Device = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
	const ours = (await attach(sender, deployed)).token
	await sender.wallet.registerContract(stockDeploy.instance, TokenContractArtifact)
	const stock = Contract.at(stockDeploy.instance.address, TokenContractArtifact, sender.wallet)
	// Whatever tags the stock mint uses, a registered sender lets this PXE find it.
	await sender.wallet.registerSender(base.relayer, "minter")

	const bridge = (await attach(minter, deployed)).stub
	await bridge.methods.mint(deployed.token.address, sender.from, 1_000n, L).send(sendOpts(minter) as never)
	for (let i = 0; i < 8; i++) await bridge.methods.mint(deployed.token.address, sender.from, 10n, K).send(sendOpts(minter) as never)
	await Contract.at(stockDeploy.instance.address, TokenContractArtifact, base.wallet)
		.methods.mint_to_private(sender.from, 1_000n)
		.send(sendOpts(minter) as never)
	await settled(
		() => balance(ours, sender.from),
		(v) => v === 1_080n,
		"the sender's labelled balance",
	)
	await settled(
		async () => BigInt(resultOf<bigint>(await stock.methods.balance_of_private(sender.from).simulate({ from: sender.from } as never))),
		(v) => v === 1_000n,
		"the sender's stock balance",
	)

	// One landed send per token opens the sender's handshakes with its recipient and with itself.
	const known = { ours: await AztecAddress.random(), stock: await AztecAddress.random() }
	const fresh = await Promise.all(Array.from({ length: SAMPLES + 1 }, () => AztecAddress.random()))
	await registry.post(POOL.root, BIRTH.root)
	await ours.methods.transfer_private(known.ours, 1n, L, POOL.path(L)).send(sendOpts(sender) as never)
	await stock.methods.transfer_private_to_private(sender.from, known.stock, 1n, 0).send(sendOpts(sender) as never)

	const oursTo = (to: (i: number) => AztecAddress) => (i: number) => ours.methods.transfer_private(to(i), 1n, L, POOL.path(L))
	const stockTo = (to: (i: number) => AztecAddress) => (i: number) => stock.methods.transfer_private_to_private(sender.from, to(i), 1n, 0)
	const at = (i: number) => fresh[i] as AztecAddress
	await registry.post(POOL.root, BIRTH.root)
	const [reused, stockReused] = await measure(sender, [oursTo(() => known.ours), stockTo(() => known.stock)])
	const [firstContact, stockFirstContact] = await measure(sender, [oursTo(at), stockTo(at)])
	// Eight 10-unit K notes cover 75 only together, so the spend takes all eight and returns 5.
	const [eightNotes] = await measure(sender, [() => ours.methods.transfer_private(known.ours, 75n, K, POOL.path(K))])
	return {
		"transfer_private, reused": reused as Row,
		"transfer_private_to_private (stock), reused": stockReused as Row,
		"transfer_private, first contact": firstContact as Row,
		"transfer_private_to_private (stock), first contact": stockFirstContact as Row,
		"transfer_private, 8 notes with change": eightNotes as Row,
	}
}

async function main(): Promise<number> {
	// An attached network is shared: another client can mine or load it mid-measurement.
	if (process.env.SANDBOX_L1_RPC || process.env.SANDBOX_NODE_URL) {
		throw new Error("bench:prove boots its own network: unset SANDBOX_L1_RPC and SANDBOX_NODE_URL")
	}
	const net = await startLocalNetwork({ runId: `tok-prove-${process.pid}-${Date.now().toString(36)}` })
	let rows: Record<string, Row>
	try {
		rows = await bench(net.nodeUrl)
	} finally {
		await net.stop()
		assertNothingLeft(net)
	}
	const oursRow = rows["transfer_private, reused"] as Row
	const stockRow = rows["transfer_private_to_private (stock), reused"] as Row
	const budgets = {
		gates: { measured: oursRow.gates, limit: stockRow.gates + GATE_MARGIN },
		provingMedianMs: { measured: oursRow.provingMs.median, limit: Math.round(stockRow.provingMs.median * PROVING_RATIO) },
	}
	const cpu = cpus()
	const out = { machine: { cpu: cpu[0]?.model ?? "unknown", cores: cpu.length }, samples: SAMPLES, rows, budgets }
	const file = join(dirname(fileURLToPath(import.meta.url)), "../bench/proving.json")
	// Number arrays on one line, as Biome formats them.
	const json = JSON.stringify(out, null, "\t").replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, xs: string) => `[${xs.split(/,\s*/).join(", ")}]`)
	writeFileSync(file, `${json}\n`)
	let failed = 0
	for (const [name, b] of Object.entries(budgets)) {
		const ok = b.measured <= b.limit
		if (!ok) failed++
		console.log(`${ok ? "✔" : "✖"} ${name}: ${b.measured} (limit ${b.limit})`)
	}
	return failed === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main())
