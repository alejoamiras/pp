/**
 * The send path rehearsed on an anvil fork of Sepolia, through fronts that fail as a public gateway does:
 * `fund` and `deploy-pool` run as the real CLIs, reading through one front and sending through the other.
 * From one snapshot after `fund`, the negative case first: the send front refuses one nonce past the send
 * budget, and `deploy-pool` must stop naming that send's hash, its nonce and how many transactions landed
 * before it. Then, from the same snapshot, every fault once in a deploy that must land each transaction
 * exactly once, one hash per nonce in its send log, with its code checked by `deploy-pool` and again by
 * `verify-deployment --pool-only`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Address, type Hex, numberToHex, parseEther } from "viem"
import { type FaultFronts, type Faults, type Fired, startFaultFronts } from "./fault-fronts"
import { type Ctx, type OnFork, onFork, scratchFile } from "./fork"
import { runCli } from "./runner"
import { must, promote } from "./scratch"

/** The nonce the negative case refuses past the budget, so three creations land before it. */
const REFUSED = 3

export type SendFaultsResult = {
	block: bigint
	transactions: number
	fired: Fired
	stopped: { landed: number; nonce: number; hash: Hex }
}

const everyFault = (sender: Address): Faults => ({
	sender,
	refuse: { nonce: 2, times: 3 },
	loseAnswer: 5,
	stale: { nonce: 8, receiptMs: 4_000, nonceMs: 8_000 },
	readError: 12,
})

/** Each fault fired as armed: a fault that never fired would pass a rehearsal that proved nothing. */
function assertFired(f: Fired, armed: Partial<Record<keyof Fired, (n: number) => boolean>>): void {
	const off = Object.entries(armed)
		.filter(([k, ok]) => !ok?.(f[k as keyof Fired] as number))
		.map(([k]) => k)
	if (off.length) throw new Error(`faults that did not fire as armed: ${off.join(", ")} (${JSON.stringify(f)})`)
}

/** `fund` through two refusals of its first top-up; every top-up shows on the read side and lands. */
async function fundThroughRefusals(c: Ctx, fronts: FaultFronts, deployer: Address): Promise<void> {
	fronts.arm({ sender: deployer, refuse: { nonce: 0, times: 2 } })
	const funded = (await must(c, "fund", [c.file])).filter((e) => e.event === "funded" && e.sent !== "0")
	assertFired(fronts.fired(), { refused: (n) => n === 2 })
	if (!funded.length || funded.some((e) => e.visibleS === undefined || e.receiptS === undefined))
		throw new Error(`fund reported no timings for its top-ups: ${JSON.stringify(funded)}`)
	c.log(`[send-faults] fund: ${funded.length} top-ups through two refusals, each shown and landed`)
}

/** `deploy-pool` with one nonce refused for good: it stops with that send's hash, nonce and landed count. */
async function stopsPastBudget(c: Ctx, fronts: FaultFronts, f: OnFork, sender: Address): Promise<SendFaultsResult["stopped"]> {
	fronts.arm({ sender, refuse: { nonce: REFUSED, times: Number.POSITIVE_INFINITY } })
	const r = await runCli("deploy-pool", [c.file, ...c.modeArgs], { ...c.env, PP_TESTNET_RUN_ROOT: join(c.dir, "runs-refused") })
	c.outputs.push(r.out)
	const hash = fronts.fired().refusedHashes.find((h) => r.out.includes(h))
	const sent = Number(await f.fork.rpc<Hex>("eth_getTransactionCount", [sender, "latest"]))
	const named = r.out.includes(`(nonce ${REFUSED}) was not admitted`) && r.out.includes(`${REFUSED} transactions landed`)
	if (r.code !== 1 || !hash || !named || sent !== REFUSED)
		throw new Error(`deploy-pool did not stop at the refused send (exit ${r.code}, ${sent} sent):\n${r.out.trim()}`)
	c.log(`[send-faults] refused past the budget: deploy-pool stopped naming ${hash}, nonce ${REFUSED}, ${REFUSED} landed`)
	return { landed: REFUSED, nonce: REFUSED, hash }
}

/** The send log's nonces are 0..n-1, each with exactly one hash; returns them in nonce order. */
function onePerNonce(log: string): Hex[] {
	const byNonce = new Map<number, Set<Hex>>()
	for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
		const { nonce, hash } = JSON.parse(line) as { nonce: number; hash: Hex }
		byNonce.set(nonce, (byNonce.get(nonce) ?? new Set()).add(hash))
	}
	const hashes = Array.from({ length: byNonce.size }, (_, i) => [...(byNonce.get(i) ?? [])])
	const bad = hashes.findIndex((h) => h.length !== 1)
	if (bad >= 0) throw new Error(`the send log holds ${hashes[bad]?.length ?? 0} hashes for nonce ${bad}, not one`)
	return hashes.map(([h]) => h as Hex)
}

/** `deploy-pool` through every fault: each fires, and every send of the deployer lands once and succeeds. */
async function landsOnce(c: Ctx, fronts: FaultFronts, f: OnFork, sender: Address): Promise<{ transactions: number; fired: Fired }> {
	fronts.arm(everyFault(sender))
	promote(c, await must(c, "deploy-pool", [c.file]), "pool-deployed")
	const fired = { ...fronts.fired() }
	fronts.arm(undefined)
	const one = (n: number) => n === 1
	assertFired(fired, {
		refused: (n) => n === 3,
		lost: one,
		alreadyImported: one,
		nullReceipts: (n) => n > 0,
		staleCounts: (n) => n > 0,
		revertedEstimates: one,
		readErrors: one,
	})
	const hashes = onePerNonce(join(c.dir, "runs", "own-rehearse-fork", "deploy-pool", "send-path.jsonl"))
	const sent = Number(await f.fork.rpc<Hex>("eth_getTransactionCount", [sender, "latest"]))
	const receipts = await Promise.all(hashes.map((h) => f.fork.rpc<{ status: Hex } | null>("eth_getTransactionReceipt", [h])))
	const failed = receipts.findIndex((r) => r?.status !== "0x1")
	if (sent !== hashes.length || failed >= 0)
		throw new Error(`the deployer sent ${sent} transactions and the log names ${hashes.length}; nonce ${failed} did not succeed`)
	c.log(`[send-faults] deploy-pool through every fault: ${sent} transactions, one hash each, all succeeded`)
	return { transactions: sent, fired }
}

export const sendFaultsRehearsal = (log: (line: string) => void): Promise<SendFaultsResult> =>
	onFork(`pp-testnet-rehearse-send-faults-${process.pid}`, "send-faults", log, async (f) => {
		const fronts = await startFaultFronts(f.fork.url, f.runId)
		f.cleanup.push(() => fronts.close())
		const c: Ctx = {
			dir: f.dir,
			file: join(f.dir, "testnet-own.json"),
			env: f.env,
			forkUrl: fronts.read.url,
			sendUrl: fronts.send.url,
			log,
			modeArgs: ["--rehearse-fork", fronts.read.url],
			tag: "send-faults",
			outputs: [],
		}
		const addresses = await scratchFile(c, join(f.dir, "home"), f.runId)
		const deployer = addresses.L1_DEPLOYER_KEY as Address
		const poolDeployer = addresses.POOL_DEPLOYER_KEY as Address
		await f.fork.rpc("anvil_setBalance", [deployer, numberToHex(parseEther("10"))])
		await fundThroughRefusals(c, fronts, deployer)
		const snapshot = await f.fork.rpc<Hex>("evm_snapshot", [])
		const stopped = await stopsPastBudget(c, fronts, f, poolDeployer)
		if (!(await f.fork.rpc<boolean>("evm_revert", [snapshot]))) throw new Error("the fork did not revert to its snapshot")
		const { transactions, fired } = await landsOnce(c, fronts, f, poolDeployer)
		await must(c, "verify-deployment", [c.file, "--pool-only"])
		return { block: f.block, transactions, fired, stopped }
	})
