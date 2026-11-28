/**
 * The send path rehearsed on an anvil fork of Sepolia, through fronts that fail as a public gateway does:
 * `fund` and `deploy-pool` run as the real CLIs, reading through one front and sending through the other.
 * From snapshots after `fund`, two negative cases first. The send front refuses one nonce past the send
 * budget, and `deploy-pool` must stop naming that send's hash, its nonce and how many transactions landed
 * before it. Then `deploy-pool` is killed outright mid-deploy: forge, whose only route to the chain was the
 * relay inside it, must end by itself, and every transaction the pool deployer landed must be in the dead
 * command's send log. Then every fault once in a deploy that must
 * land each transaction exactly once, one hash per nonce in its send log, the sends after forge's at the
 * nonces after its last though the count reads stale there, with its code checked by `deploy-pool` and
 * again by `verify-deployment --pool-only`.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { killGroup } from "@pp/run-isolation/process"
import { endGroup, groupAlive } from "@pp/run-isolation/process-group"
import { type Address, type Hex, isAddressEqual, numberToHex, parseEther } from "viem"
import { keyFilePath, loadKeys } from "../keyfile"
import { RUN_KEYS } from "../keys"
import { type FaultFronts, type Faults, type Fired, startFaultFronts } from "./fault-fronts"
import { type Ctx, type OnFork, onFork, scratchFile } from "./fork"
import { childWith, runCli, startBareCli } from "./runner"
import { assertNoKeyIn, must, promote } from "./scratch"

/** The nonce the negative case refuses past the budget, so three creations land before it. */
const REFUSED = 3
/** The send budget (35 s) less the last attempt's 1 s reserve and a second of slack: an earlier last attempt fails. */
const MIN_REFUSED_SPAN_MS = 33_000
/** How many of forge's transactions land before the CLI is killed. */
const KILL_AFTER = 5
/** How long forge may outlive the killed CLI before the rehearsal calls it a failure. */
const FORGE_EXIT_MS = 120_000
/** forge's last nonce in the pool's deploy script, where the handoff to the wallet's sends reads a stale count. */
const FORGE_LAST = 38

export type SendFaultsResult = {
	block: bigint
	transactions: number
	fired: Fired
	stopped: { landed: number; nonce: number; hash: Hex }
	killed: { landed: number; logged: number; forgeExitMs: number }
}

const everyFault = (sender: Address): Faults => ({
	sender,
	refuse: { nonce: 2, times: 3 },
	loseAnswer: 5,
	stale: [
		// Past forge's own nonce retries (five, a second apart) after the receipt shows, so only the relay's
		// floor lets the deploy go on.
		{ nonce: 8, receiptMs: 4_000, nonceMs: 15_000, revertEstimate: true },
		// Past every send after forge's, so only the shared path's floor gives the wallet the next nonce.
		{ nonce: FORGE_LAST, receiptMs: 2_000, nonceMs: 30_000 },
	],
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
	const span = fronts.fired().refusedSpanMs
	if (r.code !== 1 || !hash || !named || sent !== REFUSED || span < MIN_REFUSED_SPAN_MS)
		throw new Error(
			`deploy-pool did not stop at the refused send (exit ${r.code}, ${sent} sent, refused for ${span} ms):\n${r.out.trim()}`,
		)
	c.log(`[send-faults] refused past the budget: deploy-pool stopped naming ${hash}, nonce ${REFUSED}, ${REFUSED} landed`)
	return { landed: REFUSED, nonce: REFUSED, hash }
}

const filesUnder = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name))

const until = async (done: () => Promise<boolean>, ms: number, what: string, everyMs = 200): Promise<void> => {
	for (const deadline = Date.now() + ms; !(await done()); await Bun.sleep(everyMs))
		if (Date.now() > deadline) throw new Error(`${what} within ${ms / 1000} s`)
}

/** The hashes of `sender`'s transactions in the fork's blocks after `from`. */
async function landedSince(f: OnFork, from: bigint, sender: Address): Promise<Hex[]> {
	const head = BigInt(await f.fork.rpc<Hex>("eth_blockNumber", []))
	const out: Hex[] = []
	for (let n = from + 1n; n <= head; n++) {
		const block = await f.fork.rpc<{ transactions: { from: Address; hash: Hex }[] }>("eth_getBlockByNumber", [numberToHex(n), true])
		for (const t of block.transactions) if (isAddressEqual(t.from, sender)) out.push(t.hash)
	}
	return out
}

/**
 * `deploy-pool` killed outright once forge has landed {@link KILL_AFTER} transactions: forge must end by
 * itself, and every transaction `sender` landed, the kill settled, must have its hash in the dead
 * command's send log, which takes each attempt before its bytes leave.
 */
async function forgeEndsWithTheCli(c: Ctx, f: OnFork, sender: Address): Promise<SendFaultsResult["killed"]> {
	const from = BigInt(await f.fork.rpc<Hex>("eth_blockNumber", []))
	const logFile = join(c.dir, "deploy-pool-killed.log")
	const cli = startBareCli("deploy-pool", [c.file, ...c.modeArgs], { ...c.env, PP_TESTNET_RUN_ROOT: join(c.dir, "runs-killed") }, logFile)
	f.cleanup.push(() => killGroup(cli).then(() => {}))
	const count = async () => Number(await f.fork.rpc<Hex>("eth_getTransactionCount", [sender, "latest"]))
	await until(async () => cli.hasExited() || (await count()) >= KILL_AFTER, 300_000, `forge did not land ${KILL_AFTER} transactions`)
	const forge = cli.child.pid === undefined ? undefined : childWith(cli.child.pid, "DeployE2ELocal.s.sol")
	if (cli.hasExited() || forge === undefined)
		throw new Error(`deploy-pool ran no forge script to kill under (${cli.exitReason() ?? "running"})`)
	f.cleanup.push(() => (groupAlive(forge) ? endGroup(forge, 1_000).then(() => {}) : Promise.resolve()))
	process.kill(cli.child.pid as number, "SIGKILL")
	const killedAt = Date.now()
	await until(async () => !groupAlive(forge), FORGE_EXIT_MS, "forge did not end by itself after the CLI was killed")
	const forgeExitMs = Date.now() - killedAt
	await f.fork.rpc("evm_mine", [])
	await Bun.sleep(2_000)
	c.outputs.push(readFileSync(logFile, "utf8"))
	const landed = await landedSince(f, from, sender)
	const sendLog = filesUnder(join(c.dir, "runs-killed")).find((p) => p.endsWith("send-path.jsonl"))
	const logged = new Set(
		(sendLog ? readFileSync(sendLog, "utf8") : "")
			.split("\n")
			.filter(Boolean)
			.map((l) => (JSON.parse(l) as { hash: Hex }).hash),
	)
	const unlogged = landed.filter((h) => !logged.has(h))
	if (landed.length < KILL_AFTER || unlogged.length)
		throw new Error(`${landed.length} transactions landed, ${unlogged.length} of them not in the send log: ${unlogged.join(", ")}`)
	c.log(
		`[send-faults] CLI killed mid-deploy: forge ended by itself after ${(forgeExitMs / 1000).toFixed(1)} s; ${landed.length} landed, each in the send log (${logged.size} hashes)`,
	)
	return { landed: landed.length, logged: logged.size, forgeExitMs }
}

/** No output, log, send log or forge file of any deploy holds a value of the keys the runs loaded. */
function assertNoKeyLeft(c: Ctx, home: string): void {
	const keys = loadKeys([...RUN_KEYS.fund, ...RUN_KEYS["deploy-pool"]], keyFilePath(home))
	const files = ["runs", "runs-refused", "runs-killed"].flatMap((d) => filesUnder(join(c.dir, d)))
	assertNoKeyIn([...c.outputs, ...files.map((f) => readFileSync(f, "utf8"))], Object.values(keys))
	c.log(`[send-faults] no key value in ${c.outputs.length} outputs and ${files.length} run files`)
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

/**
 * forge's transactions, from its broadcast log, are nonces 0 to {@link FORGE_LAST}; the stale count armed
 * there was answered, and sends followed at the nonces after it.
 */
function assertHandoff(runDir: string, fired: Fired, sent: number): void {
	const latest = filesUnder(join(runDir, "broadcast")).find((p) => p.endsWith("runLocal-latest.json"))
	const forgeTxs = latest ? (JSON.parse(readFileSync(latest, "utf8")) as { transactions: unknown[] }).transactions.length : 0
	const stale = fired.staleCountsAt[FORGE_LAST] ?? 0
	if (forgeTxs !== FORGE_LAST + 1 || stale === 0 || sent <= forgeTxs)
		throw new Error(
			`the handoff was not proven: forge sent ${forgeTxs} transactions (FORGE_LAST expects ${FORGE_LAST + 1}), ${stale} stale counts answered at nonce ${FORGE_LAST}, ${sent} sent in all`,
		)
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
	const runDir = join(c.dir, "runs", "own-rehearse-fork", "deploy-pool")
	const hashes = onePerNonce(join(runDir, "send-path.jsonl"))
	const sent = Number(await f.fork.rpc<Hex>("eth_getTransactionCount", [sender, "latest"]))
	const receipts = await Promise.all(hashes.map((h) => f.fork.rpc<{ status: Hex } | null>("eth_getTransactionReceipt", [h])))
	const failed = receipts.findIndex((r) => r?.status !== "0x1")
	if (sent !== hashes.length || failed >= 0)
		throw new Error(`the deployer sent ${sent} transactions and the log names ${hashes.length}; nonce ${failed} did not succeed`)
	assertHandoff(runDir, fired, sent)
	c.log(
		`[send-faults] deploy-pool through every fault: ${sent} transactions, one hash each, all succeeded; after forge's last (${FORGE_LAST}) the sends went on at ${FORGE_LAST + 1} through a stale count`,
	)
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
		// anvil drops a snapshot once reverted to, so each case takes its own.
		const fromFunded = async <T>(run: () => Promise<T>): Promise<T> => {
			const snapshot = await f.fork.rpc<Hex>("evm_snapshot", [])
			const out = await run()
			if (!(await f.fork.rpc<boolean>("evm_revert", [snapshot]))) throw new Error("the fork did not revert to its snapshot")
			return out
		}
		const stopped = await fromFunded(() => stopsPastBudget(c, fronts, f, poolDeployer))
		fronts.arm(undefined)
		const killed = await fromFunded(() => forgeEndsWithTheCli(c, f, poolDeployer))
		const { transactions, fired } = await landsOnce(c, fronts, f, poolDeployer)
		await must(c, "verify-deployment", [c.file, "--pool-only"])
		assertNoKeyLeft(c, join(f.dir, "home"))
		return { block: f.block, transactions, fired, stopped, killed }
	})
