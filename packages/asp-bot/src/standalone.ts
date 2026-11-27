import { rmSync } from "node:fs"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { ownedWalletStore } from "@pp/bridge-core/sandbox"
import { type Hex, MAX_OBSERVATION_LAG } from "@pp/label-paths"
import { claimRows, releaseNamed } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { createPublicClient, http } from "viem"
import { type AspScope, fetchScopedLeaves } from "./asp"
import type { L1Tag } from "./l1"
import { type LivePost, liveFrom } from "./live"
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
}

/** `intake` exactly when `deployment.tokens` is non-empty. */
export type BotSecrets = { poster: Fr; intake?: Fr }

export type StandaloneOptions = {
	signal: AbortSignal
	/** Once, after this process's own first post is checkpointed. */
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
}

/** The bot's leaves for its pool: a multi-pool ASP API answers 404 without the scope. */
export const scopedLeaves = (d: StandaloneBotConfig["deployment"]) => {
	const scope: AspScope = { chainId: d.chainId, entrypoint: d.entrypoint }
	return () => fetchScopedLeaves(d.aspApiUrl, scope)
}

/** A post's margin plus the lag of `tag` behind the head beyond the registry's bound skips every post; warn, never refuse. */
async function warnMargin(c: StandaloneBotConfig, tag: L1Tag, log: Ports["log"]): Promise<void> {
	const l1 = createPublicClient({ transport: http(c.deployment.l1Rpc) })
	const [head, tagged] = await Promise.all([l1.getBlock({ blockTag: "latest" }), l1.getBlock({ blockTag: tag })])
	const lag = head.timestamp - tagged.timestamp
	if (BigInt(c.inclusionMarginSec) + lag >= MAX_OBSERVATION_LAG)
		log("margin_warning", { inclusionMarginSec: c.inclusionMarginSec, tagLagSec: lag, bound: MAX_OBSERVATION_LAG })
}

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

/** `step` settled, or `ms` passed. */
async function drain(step: Promise<unknown> | undefined, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	await Promise.race([step?.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, ms)))])
	clearTimeout(timer)
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
		try {
			await cleanup.run()
		} finally {
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
	await claimRows(c.runId, { "asp-bot": c.port }, process.pid)
	cleanup.push(async () => {
		if (!(await releaseNamed([{ port: c.port, service: "asp-bot", owner: c.runId }])))
			throw new Error(`the port registry stayed locked; ${c.port} is still listed for ${c.runId}`)
	})
	const store = ownedWalletStore("aspbot")
	cleanup.push(async () => rmSync(store, { recursive: true, force: true }))
	const book = new SnapshotBook()
	const server = await serve(book, c.port)
	cleanup.push(() => server.close())
	// Runs after the wallet stops (the stack unwinds in reverse) and before the store and server go.
	const inflight: { step?: Promise<unknown> } = {}
	cleanup.push(() => drain(inflight.step, DRAIN_MS))
	o.signal.throwIfAborted()
	let first: LivePost | undefined
	const live = await liveFrom(
		{
			...d,
			tag,
			store,
			proverEnabled: true,
			gas: "node",
			postTimeoutSec: c.postTimeoutSec,
			secrets: { poster: s.poster.toString() as Hex, ...(s.intake ? { intake: s.intake.toString() as Hex } : {}) },
			aspLeaves: scopedLeaves(d),
			onPosted: (p) => {
				first ??= p
			},
			checkRoles: true,
			signal: o.signal,
		},
		log,
	)
	cleanup.push(() => live.stop())
	o.signal.throwIfAborted()
	await warnMargin(c, tag, log)
	const poster = new Poster(live.ports, book, { self: live.self, inclusionMarginSec: BigInt(c.inclusionMarginSec) })
	// Ready once `/latest` serves its own checkpointed post: a failed read after the post can leave an
	// older snapshot current, as after a restart.
	const ready = () => !o.signal.aborted && first !== undefined && book.servesLatest(first.sequence)
	const runner = new Runner({
		// Until its own first post lands, every tick asks for one.
		tick: (postNow) => poster.tick(postNow || first === undefined),
		blockNumber: live.blockNumber,
		readiness: () =>
			ready() ? { url: server.url, port: server.port, poster: live.poster, birthIntake: live.birthIntake ?? "" } : null,
		emit: (e) => {
			if (e.event === "ready" && first && ready()) o.onReady?.({ url: server.url, post: first })
		},
		now: Date.now,
	})
	await loop(runner, o.signal, inflight)
}
