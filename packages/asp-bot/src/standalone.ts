import { rmSync } from "node:fs"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { ownedWalletStore } from "@pp/bridge-core/sandbox"
import { type Hex, MAX_OBSERVATION_LAG } from "@pp/label-paths"
import { claimRows, releaseNamed } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { createPublicClient, http } from "viem"
import { type AspScope, BOT_PRODUCT, fetchScopedLeaves, isBotUserAgent } from "./asp"
import type { L1Tag } from "./l1"
import { type LivePost, liveFrom } from "./live"
import { ownPosts } from "./own-posts"
import { Poster, type Ports } from "./loop"
import { Runner } from "./runner"
import { SnapshotBook, serve } from "./server"

export type StandaloneBotConfig = {
	deployment: {
		l1Rpc: string
		aztecNode: string
		aspApiUrl: string
		/** The L1 ASPRegistry the pool roots come from. */
		aspRegistry: Hex
		/** With `chainId`, names the pool on a multi-pool ASP API. */
		entrypoint: Hex
		chainId: number
		/** The Aztec registry's `AztecAddress.toString()`. */
		registry: Hex
		/** Labelled tokens whose births the intake approves. */
		tokens: Hex[]
	}
	/** Owns the port row. */
	runId: string
	port: number
	inclusionMarginSec: number
	postTimeoutSec: number
	/** Default "finalized". */
	tag?: L1Tag
	/** Sent with every ASP API request; default `pp-aztec-bridge-bot/<version>`. Must start with that product token. */
	userAgent?: string
}

/** `intake` exactly when `deployment.tokens` is non-empty. */
export type BotSecrets = { poster: Fr; intake?: Fr }

export type StandaloneOptions = {
	signal: AbortSignal
	/** Once, when `/latest` first serves a post this process checkpointed, which it names. */
	onReady?(r: { url: string; post: LivePost }): void
	/** Default: JSON lines on stderr. Fields carry no secret. */
	log?: Ports["log"]
}

const stderrLog: Ports["log"] = (event, fields) =>
	process.stderr.write(`${JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`)

/** @throws RangeError naming the first field out of range */
export function checkStandaloneConfig(c: StandaloneBotConfig, s: BotSecrets): void {
	const margin = c.inclusionMarginSec
	if (!Number.isSafeInteger(margin) || margin < 0 || BigInt(margin) >= MAX_OBSERVATION_LAG)
		throw new RangeError(`inclusionMarginSec must be in [0, ${MAX_OBSERVATION_LAG}): ${margin}`)
	if (!Number.isSafeInteger(c.postTimeoutSec) || c.postTimeoutSec <= 0)
		throw new RangeError(`postTimeoutSec must be positive: ${c.postTimeoutSec}`)
	if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65_535) throw new RangeError(`port must be in [1, 65535]: ${c.port}`)
	if (c.deployment.tokens.length > 0 !== (s.intake !== undefined))
		throw new RangeError("secrets.intake is required with tokens and refused without them")
	checkAspConfig(c)
}

/** The scope and name every ASP request carries, checked at runtime because the config arrives as JSON. */
function checkAspConfig(c: StandaloneBotConfig): void {
	const { chainId, entrypoint } = c.deployment
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError(`deployment.chainId must be a positive integer: ${chainId}`)
	if (typeof entrypoint !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(entrypoint))
		throw new RangeError("deployment.entrypoint must be a 20-byte hex address")
	const ua = c.userAgent
	if (ua !== undefined && !isBotUserAgent(ua))
		throw new RangeError(`userAgent must be printable ASCII of at most 128 characters starting with ${BOT_PRODUCT}`)
}

/** The bot's leaves for its pool, which a multi-pool ASP API tells apart only by the scope. */
export const scopedLeaves = (d: StandaloneBotConfig["deployment"], userAgent?: string) => {
	const scope: AspScope = { chainId: d.chainId, entrypoint: d.entrypoint }
	return () => fetchScopedLeaves(d.aspApiUrl, scope, { userAgent })
}

/** A post's margin plus the lag of `tag` behind the head beyond the registry's bound skips every post; warn, never refuse. */
async function warnMargin(c: StandaloneBotConfig, tag: L1Tag, log: Ports["log"]): Promise<void> {
	const l1 = createPublicClient({ transport: http(c.deployment.l1Rpc), ccipRead: false })
	const [head, tagged] = await Promise.all([l1.getBlock({ blockTag: "latest" }), l1.getBlock({ blockTag: tag })])
	const lag = head.timestamp - tagged.timestamp
	if (BigInt(c.inclusionMarginSec) + lag >= MAX_OBSERVATION_LAG)
		log("margin_warning", { inclusionMarginSec: c.inclusionMarginSec, tagLagSec: lag, bound: MAX_OBSERVATION_LAG })
}

/** The operator's term for its API: at most one leaves request per pool every 5 minutes. */
export const ASP_LEAVES_FLOOR_MS = 300_000

/** How long an abort waits for the in-flight step once the wallet under it has stopped. */
const DRAIN_MS = 10_000

/**
 * Steps `runner` once a second until `signal` aborts, keeping the step in flight in `inflight.step`
 * so teardown can drain it once the wallet under it stops.
 */
async function loop(runner: Runner, signal: AbortSignal, inflight: { step?: Promise<unknown> }): Promise<void> {
	let wake = () => {}
	const aborted = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))
	while (!signal.aborted) {
		inflight.step = runner.step()
		await Promise.race([inflight.step, aborted])
		if (signal.aborted) return
		const timer = setTimeout(() => wake(), 1_000)
		await Promise.race([new Promise<void>((r) => (wake = r)), aborted])
		clearTimeout(timer)
	}
}

/** Whether `step` settled before `ms` passed; resolves at whichever comes first. */
async function drain(step: Promise<unknown> | undefined, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const settled = await Promise.race([
		step === undefined
			? true
			: step.then(
					() => true,
					() => true,
				),
		new Promise<false>((r) => (timer = setTimeout(() => r(false), ms))),
	])
	clearTimeout(timer)
	return settled
}

const at = () => new Date().toISOString()

/**
 * `log` for the teardown's own lines, swallowing what the logger throws: a line must never change the
 * teardown, and under Bun an abort listener that throws ends the process before any teardown runs.
 */
function teardownLog(log: Ports["log"]): Ports["log"] {
	return (event, fields) => {
		try {
			log(event, fields)
		} catch {
			// A logger that cannot write (a full disk under its file) loses the line, not the teardown.
		}
	}
}

/**
 * `ports` whose `post` records when the post in flight began, for the teardown log; behaves as `ports`
 * otherwise. The poster never runs two posts at once.
 */
export function trackPosts(ports: Ports): { ports: Ports; postingSince: () => number | undefined } {
	let since: number | undefined
	const post: Ports["post"] = async (a) => {
		since = performance.now()
		try {
			return await ports.post(a)
		} finally {
			since = undefined
		}
	}
	return { ports: { ...ports, post }, postingSince: () => since }
}

/**
 * Wraps a teardown step to log one `teardown_step` line when it ends: its name, the time, how long it
 * took, what it threw (rethrown) and the fields it returns. A step that never ends logs nothing, so the
 * last line names the step before it. A logger that throws changes neither outcome.
 */
export function loggedStep(log: Ports["log"], step: string, fn: () => Promise<Record<string, unknown> | undefined>) {
	const say = teardownLog(log)
	return async (): Promise<void> => {
		const start = performance.now()
		const end = (fields?: Record<string, unknown>) =>
			say("teardown_step", { step, at: at(), ms: Math.round(performance.now() - start), ...fields })
		try {
			end(await fn())
		} catch (e) {
			end({ error: e instanceof Error ? e.message : String(e) })
			throw e
		}
	}
}

/**
 * Runs the poster, the snapshot server and the birth reader in this process, with keys given as
 * values: the L1 tag `c.tag`, proving on, the node's gas estimate. Claims exactly `c.port` in the host
 * registry before binding it on 127.0.0.1, and keeps the wallet store on a tmpfs it allocates. Reads
 * no stdin. Resolves once `o.signal` aborts and the server, the wallet, the store and the port row are
 * gone, at any stage of the start; a start that fails removes them too. Nothing is called back after
 * the abort.
 * @throws RangeError for a config out of range; PortClaimConflict when another run holds `c.port`;
 * Error when the registry's roles are not the derived accounts, the host has no tmpfs `/dev/shm`, or
 * the port row could not be released
 */
export async function runStandaloneBot(c: StandaloneBotConfig, s: BotSecrets, o: StandaloneOptions): Promise<void> {
	o.signal.throwIfAborted()
	checkStandaloneConfig(c, s)
	const cleanup = new CleanupStack({ signals: false })
	// A wait the drain outlived can still log; nothing reaches the caller's logger once this resolves.
	let done = false
	const log: Ports["log"] = (event, fields) => {
		if (!done) (o.log ?? stderrLog)(event, fields)
	}
	try {
		await run(c, s, { ...o, log }, cleanup)
	} catch (e) {
		if (!o.signal.aborted) throw e
	} finally {
		const start = performance.now()
		try {
			await cleanup.run()
		} finally {
			teardownLog(log)("teardown_done", { at: at(), ms: Math.round(performance.now() - start) })
			done = true
		}
	}
}

async function run(
	c: StandaloneBotConfig,
	s: BotSecrets,
	o: StandaloneOptions & { log: Ports["log"] },
	cleanup: CleanupStack,
): Promise<void> {
	const log = o.log
	const tag = c.tag ?? "finalized"
	const d = c.deployment
	let postingSince = (): number | undefined => undefined
	o.signal.addEventListener(
		"abort",
		() => {
			const since = postingSince()
			const postMs = since === undefined ? {} : { postMs: Math.round(performance.now() - since) }
			teardownLog(log)("teardown_signal", { at: at(), postInFlight: since !== undefined, ...postMs })
		},
		{ once: true },
	)
	await claimRows(c.runId, { "asp-bot": c.port }, process.pid)
	cleanup.push(
		loggedStep(log, "port_release", async () => {
			if (!(await releaseNamed([{ port: c.port, service: "asp-bot", owner: c.runId }])))
				throw new Error(`the port registry stayed locked; ${c.port} is still listed for ${c.runId}`)
		}),
	)
	const store = ownedWalletStore("aspbot")
	cleanup.push(loggedStep(log, "store_remove", async () => void rmSync(store, { recursive: true, force: true })))
	const book = new SnapshotBook()
	const server = await serve(book, c.port)
	cleanup.push(loggedStep(log, "server_close", async () => void (await server.close())))
	// Runs after the wallet stops (the stack unwinds in reverse) and before the store and server go.
	const inflight: { step?: Promise<unknown> } = {}
	cleanup.push(loggedStep(log, "drain", async () => ({ settled: await drain(inflight.step, DRAIN_MS) })))
	o.signal.throwIfAborted()
	const own = ownPosts(book)
	const live = await liveFrom(
		{
			...d,
			tag,
			store,
			proverEnabled: true,
			gas: "node",
			postTimeoutSec: c.postTimeoutSec,
			secrets: { poster: s.poster.toString() as Hex, ...(s.intake ? { intake: s.intake.toString() as Hex } : {}) },
			aspLeaves: scopedLeaves(d, c.userAgent),
			onPosted: own.posted,
			checkRoles: true,
			signal: o.signal,
		},
		log,
	)
	cleanup.push(loggedStep(log, "wallet_stop", async () => void (await live.stop())))
	const tracked = trackPosts(live.ports)
	postingSince = tracked.postingSince
	o.signal.throwIfAborted()
	await warnMargin(c, tag, log)
	const poster = new Poster(tracked.ports, book, {
		self: live.self,
		inclusionMarginSec: BigInt(c.inclusionMarginSec),
		leavesFloorMs: ASP_LEAVES_FLOOR_MS,
	})
	const served = () => (o.signal.aborted ? undefined : own.served())
	const runner = new Runner({
		// Until its own first post lands, every tick asks for one.
		tick: (postNow) => poster.tick(postNow || own.none()),
		blockNumber: live.blockNumber,
		readiness: () =>
			served() ? { url: server.url, port: server.port, poster: live.poster, birthIntake: live.birthIntake ?? "" } : null,
		emit: (e) => {
			const post = served()
			if (e.event === "ready" && post) o.onReady?.({ url: server.url, post })
		},
		now: Date.now,
	})
	await loop(runner, o.signal, inflight)
}
