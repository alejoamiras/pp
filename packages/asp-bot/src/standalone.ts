import { rmSync } from "node:fs"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { ownedWalletStore } from "@pp/bridge-core/sandbox"
import { type Hex, MAX_OBSERVATION_LAG } from "@pp/label-paths"
import { claimRows, releaseRows } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { createPublicClient, http } from "viem"
import { type AspScope, fetchScopedLeaves } from "./asp"
import type { L1Tag } from "./l1"
import { type Live, type LivePost, liveFrom } from "./live"
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

/** Refuses a start whose derived accounts are not the registry's roles: every tick would halt. */
async function assertRoles(live: Live, tip: Hex, births: boolean): Promise<void> {
	if ((await live.role("poster", tip)) !== live.self) throw new Error(`the registry's poster is not ${live.poster}`)
	if (births && (await live.role("birth_intake", tip)) !== BigInt(live.birthIntake ?? 0))
		throw new Error(`the registry's birth intake is not ${live.birthIntake}`)
}

/** A post's margin plus the lag of `tag` behind the head beyond the registry's bound skips every post; warn, never refuse. */
async function warnMargin(c: StandaloneBotConfig, tag: L1Tag, log: Ports["log"]): Promise<void> {
	const l1 = createPublicClient({ transport: http(c.deployment.l1Rpc) })
	const [head, tagged] = await Promise.all([l1.getBlock({ blockTag: "latest" }), l1.getBlock({ blockTag: tag })])
	const lag = head.timestamp - tagged.timestamp
	if (BigInt(c.inclusionMarginSec) + lag >= MAX_OBSERVATION_LAG)
		log("margin_warning", { inclusionMarginSec: c.inclusionMarginSec, tagLagSec: lag, bound: MAX_OBSERVATION_LAG })
}

/** Steps `runner` once a second until `signal` aborts; an abort leaves an in-flight step behind unawaited. */
async function loop(runner: Runner, signal: AbortSignal): Promise<void> {
	const aborted = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))
	while (!signal.aborted) {
		await Promise.race([runner.step(), aborted])
		await Promise.race([new Promise((r) => setTimeout(r, 1_000)), aborted])
	}
}

/**
 * Runs the poster, the snapshot server and the birth reader in this process, with keys given as
 * values: the L1 tag `c.tag`, proving on, the node's gas estimate. Claims exactly `c.port` in the host
 * registry before binding it on 127.0.0.1, and keeps the wallet store on a tmpfs it allocates. Reads
 * no stdin. Resolves once `o.signal` aborts and the server, the wallet, the store and the port row are
 * gone; a start that fails removes them too.
 * @throws RangeError for a config out of range; PortClaimConflict when another run holds `c.port`;
 * Error when the registry's roles are not the derived accounts, or the host has no tmpfs `/dev/shm`
 */
export async function runStandaloneBot(c: StandaloneBotConfig, s: BotSecrets, o: StandaloneOptions): Promise<void> {
	o.signal.throwIfAborted()
	checkStandaloneConfig(c, s)
	const log = o.log ?? stderrLog
	const tag = c.tag ?? "finalized"
	const d = c.deployment
	const cleanup = new CleanupStack({ signals: false })
	try {
		await claimRows(c.runId, { "asp-bot": c.port }, process.pid)
		cleanup.push(async () => void (await releaseRows(c.runId)))
		const store = ownedWalletStore("aspbot")
		cleanup.push(async () => rmSync(store, { recursive: true, force: true }))
		const book = new SnapshotBook()
		const server = await serve(book, c.port)
		cleanup.push(() => server.close())
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
			},
			log,
		)
		cleanup.push(() => live.stop())
		await assertRoles(live, (await live.ports.tip()).hash, d.tokens.length > 0)
		await warnMargin(c, tag, log)
		const poster = new Poster(live.ports, book, { self: live.self, inclusionMarginSec: BigInt(c.inclusionMarginSec) })
		const runner = new Runner({
			// Until its own first post lands, every tick asks for one.
			tick: (postNow) => poster.tick(postNow || first === undefined),
			blockNumber: live.blockNumber,
			readiness: () =>
				first ? { url: server.url, port: server.port, poster: live.poster, birthIntake: live.birthIntake ?? "" } : null,
			emit: (e) => {
				if (e.event === "ready" && first) o.onReady?.({ url: server.url, post: first })
			},
			now: Date.now,
		})
		await loop(runner, o.signal)
	} finally {
		await cleanup.run()
	}
}
