/**
 * Rehearsal of an operator target on an anvil fork of Sepolia this run owns: `keys` into a scratch home,
 * `fund`, `verify-deployment --pool-only`, then `seed` refused while the owner holds none of the asset,
 * `seed --no-register` failing before any registration, `seed`, `seed --no-register`, and `seed` refused
 * on a file whose operator block no longer reads as the pool, with no key file to read. Every request to
 * the operator's ASP goes through a recording front to a stand-in; the stopped runs must make none, and
 * the bot's leaves request is made once through that front.
 */
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { scopedLeaves } from "@pp/asp-bot/standalone"
import { startStandInAsp } from "@pp/pp-env/sepolia"
import { claimPort } from "@pp/run-isolation/ports"
import {
	type Address,
	createPublicClient,
	createWalletClient,
	erc20Abi,
	http,
	keccak256,
	numberToHex,
	parseAbi,
	parseEther,
	zeroAddress,
} from "viem"
import { sepolia } from "viem/chains"
import { parseDeployment, type TestnetDeployment } from "../schema"
import { assertNoKeyLeft, onFork } from "./fork"
import { budgetCheck, gasBySender } from "./gas"
import { OPERATOR_FORK_STEPS, type OperatorForkStep } from "./operator-steps"
import { type Recorded, type Recorder, startRecorder } from "./recorder"
import { runCli } from "./runner"
import { checkDepositDebit } from "../verify"
import { type Amounts, expectedOf, filesUnder, loadScratch, must, type Scratch, writeScratch } from "./scratch"

const FIAT_TOKEN_ABI = parseAbi([
	"function masterMinter() view returns (address)",
	"function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
	"function mint(address to, uint256 amount) returns (bool)",
])
const ASP_ROOT_ABI = parseAbi(["function latestASPRoot() view returns (uint256)"])
/**
 * The fork deposits the smallest note whose 1% fee is non-zero and rounds differently down than up, so
 * a debit computed in the wrong direction fails here; the committed amounts are checked by read alone.
 */
const AMOUNTS: Amounts = { debit: 102n, note: 101n, bridge: 101n }

/** The requests one step made to the operator's ASP, in order. */
export type AspPhase = { step: string; requests: Recorded[] }
export type OperatorForkResult = { block: bigint; debit: bigint; gas: Record<string, bigint>; asp: AspPhase[] }

type Fork = { url: string; rpc(method: string, params: unknown[]): Promise<unknown> }
type Pool = NonNullable<TestnetDeployment["pool"]>

/** `expected` from `keys`' addresses without the own pool's roles. */
function operatorExpected(addresses: Record<string, string>): NonNullable<TestnetDeployment["expected"]> {
	const { aspPostman: _postman, poolDeployer: _deployer, ...expected } = expectedOf(addresses, AMOUNTS)
	return expected
}

/** `amount` of the asset for `to`, minted by the token's master minter acting as its own minter. */
async function mintAsset(fork: Fork, asset: Address, to: Address, amount: bigint): Promise<void> {
	const client = createPublicClient({ transport: http(fork.url) })
	const master = await client.readContract({ address: asset, abi: FIAT_TOKEN_ABI, functionName: "masterMinter" })
	await fork.rpc("anvil_impersonateAccount", [master])
	await fork.rpc("anvil_setBalance", [master, numberToHex(parseEther("1"))])
	const chain = { ...sepolia, rpcUrls: { default: { http: [fork.url] } } }
	const boss = createWalletClient({ account: master, chain, transport: http(fork.url) })
	for (const [functionName, args] of [
		["configureMinter", [master, amount]],
		["mint", [to, amount]],
	] as const) {
		const hash = await boss.writeContract({ address: asset, abi: FIAT_TOKEN_ABI, functionName, args } as never)
		const receipt = await client.waitForTransactionReceipt({ hash })
		if (receipt.status !== "success") throw new Error(`${functionName} on ${asset} reverted`)
	}
	await fork.rpc("anvil_stopImpersonatingAccount", [master])
}

type Owner = { fork: Fork; owner: Address; asset: Address }

/**
 * Runs `seed` under `env`, which must exit `code` (2, a guard's refusal; 1, a failure) with output matching
 * `why`, sending nothing from the owner and moving none of its asset. The code alone does not say whether
 * the run stopped before or after its key read.
 */
async function seedStops(s: Scratch, o: Owner, args: readonly string[], code: 1 | 2, why: RegExp, env = s.env): Promise<void> {
	const client = createPublicClient({ transport: http(o.fork.url) })
	const state = () =>
		Promise.all([
			client.getTransactionCount({ address: o.owner }),
			client.readContract({ address: o.asset, abi: erc20Abi, functionName: "balanceOf", args: [o.owner] }),
		])
	const before = await state()
	const r = await runCli("seed", [...args, ...s.modeArgs], env)
	s.outputs.push(r.out)
	const name = ["seed", ...args.slice(1)].join(" ")
	if (r.code !== code || !why.test(r.out))
		throw new Error(`${name} should exit ${code} with ${why}; it exited ${r.code}:\n${r.out.trim()}`)
	const after = await state()
	if (after.join() !== before.join()) throw new Error(`a stopped seed moved the owner's nonce or balance: ${before} to ${after}`)
	s.log(`[${s.tag}] ${name} exited ${code}: ${r.out.trim().split("\n").at(-1)?.slice(0, 160)}`)
}

/** What `bot` hands the standalone bot, before a bridge exists: the leaves request reads only the scope and the URL. */
function botDeployment(d: TestnetDeployment, aspApiUrl: string): Parameters<typeof scopedLeaves>[0] {
	const pool = d.pool as Pool
	return {
		l1Rpc: d.network.l1Rpc,
		aztecNode: d.network.aztecNode,
		aspApiUrl,
		aspRegistry: pool.aspRegistry,
		entrypoint: pool.entrypoint,
		chainId: d.network.l1ChainId,
		registry: zeroAddress,
		tokens: [],
	}
}

/** A copy of the scratch file whose vault implementation reads as other code than the pool's. */
function tamperedFile(s: Scratch, dir: string): string {
	const d = loadScratch(s)
	const operator = d.operator as NonNullable<TestnetDeployment["operator"]>
	const vault = { ...operator.code.vault, implementationCodeHash: keccak256(operator.code.vault.implementationCodeHash) }
	const file = join(dir, "tampered.json")
	writeScratch({ ...s, file }, { ...d, operator: { ...operator, code: { ...operator.code, vault } } })
	return file
}

/**
 * Steps that keep each one's requests to the operator's ASP. A `quiet` step must make none, and a step
 * that throws prints every request recorded so far before the error goes on.
 */
function aspSteps(front: Recorder, tag: string, log: (line: string) => void) {
	const phases: AspPhase[] = []
	const print = () => {
		for (const p of phases)
			for (const r of p.requests) log(`[${tag}] ${p.step}: ${r.method} ${r.path} ${new URLSearchParams(r.query)} -> ${r.status}`)
	}
	const step = async <T>(name: OperatorForkStep, run: () => Promise<T>, o: { quiet?: boolean } = {}): Promise<T> => {
		const from = front.requests.length
		const phase: AspPhase = { step: name, requests: [] }
		phases.push(phase)
		try {
			const out = await run()
			phase.requests = front.requests.slice(from)
			if (o.quiet && phase.requests.length > 0)
				throw new Error(`${name} made ${phase.requests.length} requests to the operator's ASP; a stopped run makes none`)
			return out
		} catch (e) {
			phase.requests = front.requests.slice(from)
			print()
			throw e
		}
	}
	return { phases, step, print }
}

/** The stand-in, the recording front before it, and the scratch file pointing at the front. */
async function aspFronts(runId: string, forkUrl: string, pool: Pool, push: (stop: () => Promise<void>) => void) {
	const client = createPublicClient({ transport: http(forkUrl) })
	const root = await client.readContract({ address: pool.aspRegistry, abi: ASP_ROOT_ABI, functionName: "latestASPRoot" })
	const standIn = await startStandInAsp({
		port: await claimPort(runId, "rehearse-asp-stand-in"),
		entrypoint: pool.entrypoint,
		deployBlock: BigInt(pool.deployBlock),
		root,
	})
	push(standIn.stop)
	const front = startRecorder({ port: await claimPort(runId, "rehearse-asp-front"), upstream: standIn.url })
	push(front.stop)
	return front
}

export const operatorForkRehearsal = (target: string, log: (line: string) => void): Promise<OperatorForkResult> =>
	onFork(`pp-testnet-rehearse-${target}-${process.pid}`, target, log, async ({ runId, dir, block, fork, env, cleanup }) => {
		const committed = parseDeployment(
			JSON.parse(readFileSync(fileURLToPath(new URL(`../../deployments/testnet-${target}.json`, import.meta.url)), "utf8")),
		)
		if (committed.target === "own" || !committed.pool || !committed.operator || !committed.expected)
			throw new Error(`target ${target} is not an operator target with its expected, pool and operator sections`)
		await checkDepositDebit(
			createPublicClient({ transport: http(fork.url) }),
			committed.pool.entrypoint,
			committed.pool.asset,
			committed.expected.amounts,
		)
		log(
			`[${target}] the committed note of ${committed.expected.amounts.note} debits ${committed.expected.amounts.debit} at the fork's block`,
		)
		const s: Scratch = {
			file: join(dir, `testnet-${target}.json`),
			env,
			modeArgs: ["--rehearse-fork", fork.url],
			tag: target,
			log,
			outputs: [],
		}
		const keys = await runCli("keys", [], { ...env, HOME: join(dir, "home") })
		s.outputs.push(keys.out)
		if (keys.code !== 0) throw new Error(`keys exited ${keys.code}:\n${keys.out.trim()}`)
		const addresses = Object.fromEntries(keys.events.map((e) => [e.name as string, e.address as string]))
		const front = await aspFronts(runId, fork.url, committed.pool, (stop) => cleanup.push(stop))
		const { bridge: _bridge, ...configured } = committed
		writeScratch(s, {
			...configured,
			// Never the live send endpoint, which would carry a fork-signed transaction to Sepolia.
			network: { ...committed.network, l1Rpc: fork.url, l1SendRpc: fork.url },
			expected: operatorExpected(addresses),
			pool: { ...committed.pool, aspApiUrl: front.url },
		})
		const d = loadScratch(s)
		const { asset } = committed.pool
		const owner = d.expected?.canaryOwner as Address
		const o: Owner = { fork, owner, asset }
		const debit = d.expected?.amounts.debit as bigint
		const { phases: asp, step, print } = aspSteps(front, target, log)
		await fork.rpc("anvil_setBalance", [addresses.L1_DEPLOYER_KEY as Address, numberToHex(parseEther("10"))])
		await step("fund", () => must(s, "fund", [s.file]))
		await step("verify-deployment --pool-only", () => must(s, "verify-deployment", [s.file, "--pool-only"]))
		const short = new RegExp(`refused: balance: .* ${debit} short of the deposit's debit ${debit}`)
		await step("seed, no asset", () => seedStops(s, o, [s.file], 2, short), { quiet: true })
		// Exactly two debits: the second deposit spends the balance to zero, so `seed`'s check admits an equal balance.
		await mintAsset(fork, asset, owner, 2n * debit)
		await step(
			"seed --no-register, unregistered",
			() => seedStops(s, o, [s.file, "--no-register"], 1, /failed: the keystore holds no complete registration/),
			{ quiet: true },
		)
		const seeded = await step("seed", () => must(s, "seed", [s.file]))
		await step("seed --no-register", () => must(s, "seed", [s.file, "--no-register"]))
		// A scratch home with no key file: the refusal must come before the key read.
		const keyless = join(dir, "no-keys")
		mkdirSync(keyless, { mode: 0o700 })
		await step(
			"seed, operator block moved",
			() =>
				seedStops(
					s,
					o,
					[tamperedFile(s, dir)],
					2,
					/refused: operator: the pool moved since block \d+, where it was reviewed: code\.vault\.implementationCodeHash differ/,
					{ ...s.env, PP_TESTNET_SCRATCH_HOME: keyless },
				),
			{ quiet: true },
		)
		const leaves = await step("bot leaves", () => scopedLeaves(botDeployment(d, front.url))())
		if (leaves.length !== 0) throw new Error(`the stand-in served ${leaves.length} leaves`)
		const ran = asp.map((p) => p.step).join(" · ")
		if (ran !== OPERATOR_FORK_STEPS.join(" · "))
			throw new Error(`the rehearsal ran ${ran}; operator-steps.ts lists ${OPERATOR_FORK_STEPS.join(" · ")}`)
		const gas = budgetCheck(await gasBySender(fork.url, block), addresses)
		assertNoKeyLeft(s, join(dir, "home"), filesUnder(join(dir, "runs")))
		print()
		return { block, debit: BigInt(seeded.find((e) => e.event === "seeded")?.debit as string), gas, asp }
	})
