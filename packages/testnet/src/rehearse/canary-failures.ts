/**
 * Rehearsal part `canary-failures`, on a running local stack (`PP_STACK_MANIFEST`): the bot's wait for
 * approval finality and the canary's failure exits, through the real CLIs with `--rehearse`, each staged
 * from outside behind a loopback proxy. Two approvals while the bot's `finalized` trails `latest`,
 * reported as the wait for approval finality; a self-transfer the node refuses, which ends the canary red
 * before any burn; an Outbox that shows no root, so the canary exits 3, then `canary --settle` over every
 * burn it listed; an interrupted canary, then `pause`.
 */
import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { PORTAL_FACTORY_ABI, parseStackManifest, serializeStackManifest } from "@pp/bridge-core"
import { CleanupStack, killGroup, type OwnedChild } from "@pp/run-isolation/process"
import { groupGone, groupMembers } from "@pp/run-isolation/process-group"
import { createPublicClient, type Hex, http, type PublicClient, toHex } from "viem"
import type { TestnetDeployment } from "../schema"
import { finalizedAt, outboxWithoutRoots, refuseSendWhile, startRpcProxy } from "./proxy"
import { type Event, eventsOf, startCli, untilEvent } from "./runner"
import { assertNoKeyIn, expectedOf, loadScratch, must, type Scratch, writeScratch } from "./scratch"
import { AMOUNTS, deployBridge, type StackRun, stackFile, stackRun, startBot, stopBot } from "./stack"

/** A rehearsal's exit 3: three or so 15 s polls of an Outbox that never shows a root. */
const EXIT_3_BUDGET_MS = 40_000
const CANARY_MS = 20 * 60_000
/** Each finality event follows a new root, which the bot fetches no sooner than its 5-minute leaves floor. */
const FINALITY_EVENT_MS = 15 * 60_000

export type CanaryFailuresResult = Record<"approvalFinality" | "refusedSelfTransfer" | "exit3ThenSettle" | "interruptedThenPause", number>

type Ctx = StackRun & {
	cleanup: CleanupStack
	l1: PublicClient
	factory: Hex
	/** The scratch file with its L1 or node behind a proxy: the bot's, the canary's without Outbox roots, the canary's refusing node. */
	files: { bot: Variant; outbox: Variant; node: Variant }
	bot: { bot: OwnedChild; ready: Event; log: string }
	/** The block the bot's proxy serves as `finalized`; undefined passes the tag through. */
	pin: { at?: bigint }
	/** The run root of the canary whose self-transfer the node proxy refuses. */
	refuse: { root?: string }
}

type CanaryRun = { code: number | null; events: Event[]; report: Record<string, unknown> }

/** Throws naming each check that failed, with what the run showed. */
function expectAll(what: string, checks: Record<string, boolean>, shown: unknown): void {
	const failed = Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]))
	if (failed.length) throw new Error(`${what}: failed ${failed.join("; ")}\n${JSON.stringify(shown, null, 2)}`)
}

const sameHashes = (a: readonly unknown[], b: readonly unknown[]) =>
	a.length === b.length &&
	[...a]
		.map((h) => String(h).toLowerCase())
		.sort()
		.join() ===
		[...b]
			.map((h) => String(h).toLowerCase())
			.sort()
			.join()

const burnsOf = (report: Record<string, unknown>) => ((report.burns ?? []) as { txHash: string }[]).map((b) => b.txHash)
const listedOf = (events: Event[]) =>
	String(events.find((e) => e.event === "unsettled")?.burns ?? "")
		.split(" ")
		.filter(Boolean)

type Variant = { file: string; modeArgs: readonly string[] }

/**
 * A copy of the scratch file whose `network` points a CLI at a proxy, and a copy of the stack manifest
 * naming the same endpoints, since `--rehearse` refuses a file whose URLs are not its manifest's.
 */
function variant(s: Scratch, manifestPath: string, name: string, network: Partial<TestnetDeployment["network"]>): Variant {
	const file = join(dirname(s.file), `testnet-own-${name}.json`)
	const d = loadScratch(s)
	const n = { ...d.network, ...network }
	writeScratch({ ...s, file }, { ...d, network: n })
	const m = parseStackManifest(JSON.parse(readFileSync(manifestPath, "utf8")))
	const manifest = join(dirname(s.file), `stack-${name}.json`)
	const proxied = parseStackManifest(JSON.parse(serializeStackManifest({ ...m, l1Rpc: n.l1Rpc, aztecNode: n.aztecNode })))
	writeFileSync(manifest, serializeStackManifest(proxied))
	return { file, modeArgs: ["--rehearse", manifest] }
}

/** The step of the last send the canary report under `root` records; the canary flushes it before the broadcast. */
function lastSendStep(root: string): unknown {
	const runs = join(root, "own-rehearse")
	try {
		const run = readdirSync(runs).filter((n) => n.startsWith("canary-"))[0] ?? ""
		const report = JSON.parse(readFileSync(join(runs, run, "report.json"), "utf8")) as { sends?: { step?: string }[] }
		return report.sends?.at(-1)?.step
	} catch {
		return undefined
	}
}

/** `deploy` on the stack, the three proxies and their files, the bot behind its proxy, and `open`. */
async function setUp(r: StackRun, manifestPath: string, cleanup: CleanupStack): Promise<Ctx> {
	const { s, runId } = r
	await stackFile(s, manifestPath, runId)
	const named = (await must(s, "addresses", [s.file])).find((e) => e.event === "addresses") as Record<string, string>
	writeScratch(s, { ...loadScratch(s), expected: expectedOf(named, AMOUNTS) })
	const factory = await deployBridge(s)
	const { network } = loadScratch(s)
	const pin: Ctx["pin"] = {}
	const refuse: Ctx["refuse"] = {}
	const proxy = async (service: string, upstream: string, rule: Parameters<typeof startRpcProxy>[0]["rule"]) => {
		const p = await startRpcProxy({ runId, service, upstream, rule })
		cleanup.push(() => p.close())
		return p.url
	}
	const files = {
		bot: variant(s, manifestPath, "bot", {
			l1Rpc: await proxy(
				"rehearse-bot-l1",
				network.l1Rpc,
				finalizedAt(() => pin.at),
			),
		}),
		outbox: variant(s, manifestPath, "outbox", {
			l1Rpc: await proxy("rehearse-canary-l1", network.l1Rpc, outboxWithoutRoots(network.outbox)),
		}),
		node: variant(s, manifestPath, "node", {
			aztecNode: await proxy(
				"rehearse-canary-node",
				network.aztecNode,
				refuseSendWhile(() => refuse.root !== undefined && lastSendStep(refuse.root) === "selfTransfer"),
			),
		}),
	}
	const bot = await startBot({ ...s, ...files.bot }, r.dir, 1, cleanup)
	await must(s, "open", [s.file, "--factory", factory])
	const l1 = createPublicClient({ transport: http(network.l1Rpc) }) as PublicClient
	return { ...r, cleanup, l1, factory, files, bot, pin, refuse }
}

const canaryArgs = (c: Ctx) => ["--min-sequence", String(c.bot.ready.sequence), "--post", String(c.bot.ready.txHash)]

/** Runs the canary as its own process group until it exits; `during` acts on it meanwhile. Nothing of its group may outlive it. */
async function canaryRun(
	c: Ctx,
	name: string,
	o: { variant: Variant; env?: NodeJS.ProcessEnv; during?: (log: string, child: OwnedChild) => Promise<void> },
): Promise<CanaryRun> {
	const log = join(c.dir, `${name}.log`)
	const child = startCli("canary", [o.variant.file, ...canaryArgs(c), ...o.variant.modeArgs], o.env ?? c.s.env, log)
	c.cleanup.push(async () => void (await killGroup(child)))
	await o.during?.(log, child)
	let timer: ReturnType<typeof setTimeout> | undefined
	const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), CANARY_MS)))
	const ended = await Promise.race([child.exited, late])
	clearTimeout(timer)
	if (ended === "late") throw new Error(`${name} did not end within ${CANARY_MS} ms`)
	const out = readFileSync(log, "utf8")
	c.s.outputs.push(out)
	const pid = child.child.pid as number
	if (!(await groupGone(pid, 5_000)))
		throw new Error(
			`${name} left ${groupMembers(pid)
				.map((m) => m.args)
				.join("; ")} running`,
		)
	const events = eventsOf(out)
	const path = events.find((e) => e.event === "canary-report")?.path
	if (typeof path !== "string") throw new Error(`${name} wrote no report (${child.exitReason()}):\n${out.slice(-3000)}`)
	const text = readFileSync(path, "utf8")
	c.s.outputs.push(text)
	return { code: child.child.exitCode, events, report: JSON.parse(text) as Record<string, unknown> }
}

/** Approves a fresh label through the stack's mock ASP, which publishes the grown root; returns that root and its L1 block. */
async function approve(c: Ctx): Promise<{ root: bigint; block: bigint }> {
	const url = loadScratch(c.s).pool?.aspApiUrl as string
	const label = toHex(randomBytes(31))
	const res = await fetch(`${url}/admin/approve-label`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ label }),
	})
	const body = (await res.json()) as { root?: Hex; txId?: Hex; published?: boolean }
	if (!res.ok || !body.published || !body.txId || !body.root)
		throw new Error(`the mock ASP did not publish an approval: ${JSON.stringify(body)}`)
	const { blockNumber } = await c.l1.waitForTransactionReceipt({ hash: body.txId })
	return { root: BigInt(body.root), block: blockNumber }
}

/**
 * Two approvals while the bot reads `finalized` below both; then `finalized` moves to the first one's
 * block, where the registry holds its root while the ASP already serves the second one's leaves. The bot
 * must report that as the wait for approval finality, and post the second root once `finalized` covers it.
 */
async function approvalFinality(c: Ctx): Promise<void> {
	c.pin.at = (await c.l1.getBlock({ blockTag: "finalized" })).number
	const first = await approve(c)
	const second = await approve(c)
	if (second.block <= first.block) throw new Error(`both approvals landed in L1 block ${first.block}`)
	c.pin.at = first.block
	const test = (e: Event) => e.event === "approval-finality-wait" && BigInt(String(e.aspRoot)) === second.root
	const wait = await untilEvent(c.bot.log, { what: "approval-finality-wait", test }, c.bot.bot, FINALITY_EVENT_MS)
	c.pin.at = second.block
	const reached = await untilEvent(c.bot.log, "approval-finality-reached", c.bot.bot, FINALITY_EVENT_MS)
	c.pin.at = undefined
	expectAll(
		"approval finality",
		{
			"the wait names the finalized root": BigInt(String(wait.chainRoot)) === first.root,
			"the post carries the second root": BigInt(String(reached.poolRoot)) === second.root,
		},
		{ first, second, wait, reached },
	)
	c.s.log(`[${c.s.tag}] approval finality waited ${reached.waitedMs} ms; sequence ${reached.sequence} posted the second root`)
}

/** The node refuses the canary's checked self-transfer: the canary must end red with no burn. */
async function refusedSelfTransfer(c: Ctx): Promise<void> {
	c.refuse.root = join(c.dir, "runs-refused")
	const env = { ...c.s.env, PP_TESTNET_RUN_ROOT: c.refuse.root }
	const run = await canaryRun(c, "canary-refused", { variant: c.files.node, env }).finally(() => {
		c.refuse.root = undefined
	})
	const sends = (run.report.sends ?? []) as { step?: string; outcome?: string }[]
	expectAll(
		"a refused self-transfer",
		{
			"exit 1": run.code === 1,
			"error class UNRESOLVED_SEND": run.report.errorClass === "UNRESOLVED_SEND",
			"the self-transfer is the last send, refused":
				sends.at(-1)?.step === "selfTransfer" && sends.at(-1)?.outcome === "unresolved-send",
			"no burn": burnsOf(run.report).length === 0 && !run.events.some((e) => e.event === "unsettled"),
		},
		run.report,
	)
	c.s.log(`[${c.s.tag}] the canary exited 1 (UNRESOLVED_SEND) after ${sends.length} sends, with no burn`)
}

/** No Outbox root within a short budget: exit 3 listing every burn; then `canary --settle` settles each one on the real Outbox. */
async function exit3ThenSettle(c: Ctx): Promise<void> {
	const env = { ...c.s.env, PP_TESTNET_EPOCH_PROOF_BUDGET_MS: String(EXIT_3_BUDGET_MS) }
	const run = await canaryRun(c, "canary-exit-3", { variant: c.files.outbox, env })
	const burns = burnsOf(run.report)
	const listed = listedOf(run.events)
	expectAll(
		"an epoch proof past its budget",
		{
			"exit 3": run.code === 3,
			"exit class EPOCH_PROOF_TIMEOUT": run.report.exitClass === "EPOCH_PROOF_TIMEOUT",
			"a burn": burns.length > 0,
			"every burn listed unsettled": sameHashes(listed, burns) && sameHashes((run.report.unsettled ?? []) as string[], burns),
			"nothing settled": run.report.settles === undefined,
		},
		run.report,
	)
	const events = await must(c.s, "canary", [c.s.file, "--settle", ...listed])
	const report = events.find((e) => e.event === "canary-report")
	const settled = events.filter((e) => e.event === "settled").map((e) => e.l2TxHash)
	expectAll("canary --settle", { PASS: report?.exitClass === "PASS", "each listed burn settled": sameHashes(settled, listed) }, events)
	c.s.outputs.push(readFileSync(String(report?.path), "utf8"))
	c.s.log(`[${c.s.tag}] the canary exited 3 listing ${listed.length} burns; --settle settled each`)
}

/** SIGINT once a burn has landed: the report lists every burn unsettled; `pause` then pauses the entries. */
async function interruptedThenPause(c: Ctx): Promise<void> {
	const landedBurn = {
		what: "a landed burn",
		test: (e: Event) => e.event === "l2-sent" && e.step === "burn" && e.outcome === "checkpointed",
	}
	const run = await canaryRun(c, "canary-interrupted", {
		variant: c.files.outbox,
		during: async (log, child) => {
			await untilEvent(log, landedBurn, child, CANARY_MS)
			// The canary alone, not its group: the group's leader only waits on it, and its prover child
			// must end with it, which the check that nothing of the group outlives it then shows.
			const leader = child.child.pid as number
			const canary = groupMembers(leader).find((m) => m.pid !== leader && m.args.includes("cli/canary.ts"))
			if (!canary) throw new Error("the canary's process was gone before the interrupt")
			process.kill(canary.pid, "SIGINT")
		},
	})
	const burns = burnsOf(run.report)
	expectAll(
		"an interrupted canary",
		{
			"exit 1": run.code === 1,
			"error class INTERRUPTED": run.report.errorClass === "INTERRUPTED",
			"a burn": burns.length > 0,
			"every burn listed unsettled":
				sameHashes(listedOf(run.events), burns) && sameHashes((run.report.unsettled ?? []) as string[], burns),
		},
		run.report,
	)
	const paused = (await must(c.s, "pause", [c.s.file, "--factory", c.factory])).find((e) => e.event === "paused")
	const readBack = await c.l1.readContract({ address: c.factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })
	expectAll("pause after the interrupt", { paused: paused !== undefined, "entries read back paused": readBack === true }, paused)
	c.s.log(`[${c.s.tag}] the interrupted canary exited 1 (INTERRUPTED) listing ${burns.length} burns; entries read back paused`)
}

export async function canaryFailuresRehearsal(manifestPath: string, log: (line: string) => void): Promise<CanaryFailuresResult> {
	const cleanup = new CleanupStack()
	const r = stackRun("canary-failures", manifestPath, log)
	const timed = async (name: string, f: () => Promise<void>) => {
		const t0 = performance.now()
		await f()
		const ms = Math.round(performance.now() - t0)
		log(`[${r.s.tag}] ${name} passed in ${ms} ms`)
		return ms
	}
	try {
		const c = await setUp(r, manifestPath, cleanup)
		const result: CanaryFailuresResult = {
			approvalFinality: await timed("approval finality", () => approvalFinality(c)),
			refusedSelfTransfer: await timed("refused self-transfer", () => refusedSelfTransfer(c)),
			exit3ThenSettle: await timed("exit 3, then --settle", () => exit3ThenSettle(c)),
			interruptedThenPause: await timed("interrupted, then pause", () => interruptedThenPause(c)),
		}
		await stopBot(r.s, c.bot)
		assertNoKeyIn(r.s.outputs, Object.values(r.keys))
		rmSync(r.dir, { recursive: true, force: true })
		return result
	} catch (e) {
		log(`[${r.s.tag}] failed; its logs and scratch files stay in ${r.dir}`)
		throw e
	} finally {
		await cleanup.run()
	}
}
