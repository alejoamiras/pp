/**
 * The allow list for a stack build: the registry's record and its time read at one Aztec block, and
 * each label checked in the page's one allow-list worker against the bot's snapshot of that record's
 * roots. Work is keyed by the roots, never the sequence: the bot re-posts the same roots under a new
 * sequence every few minutes, and that costs no download and no hash. A list that failed is not
 * fetched again until a manual Check again, which backs off.
 */
import { type Hex, readRootRecord } from "@pp/label-paths"
import { z } from "zod"
import { type AllowListCode, AllowListError } from "../errors"
import type { AllowListPort, AllowListProgress, AllowListView, Timer } from "../ports"
import type { LabelCheck, Origin } from "../stack-types"
import { type DownloadLimits, downloadSnapshot } from "./snapshot-download"
import { type JobReply, type JobRequest, type ListFailure, rootsKey } from "./snapshot-protocol"

/**
 * Chain seconds a checked spend may take from the anchor to its own proof's anchor: a label is
 * `ACTIVE` only if the record is still fresh that much later.
 */
export const PROVING_BUDGET_SEC = 300n

/** The first manual retry of a failed list waits this long, each later one twice the last, up to the cap. */
const BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 300_000
const NODE_TIMEOUT_MS = 10_000

export interface JobWorker {
	post(req: JobRequest): void
	onReply(f: (reply: JobReply) => void): void
	/** The worker failed to load, crashed, or sent a message that could not be read. */
	onError(f: () => void): void
	terminate(): void
}

export interface AllowListDeps {
	nodeUrl: string
	/** The registry's `AztecAddress.toString()`. */
	registry: Hex
	botUrl: string
	timer: Timer
	/** A fresh worker; the page starts one at the first check and again only after a Cancel. */
	worker(): JobWorker
	fetch?: typeof fetch
	limits?: DownloadLimits
}

/** The page's worker over the browser's `Worker`. */
export function browserWorker(): JobWorker {
	const w = new Worker(new URL("./allow-list.worker.ts", import.meta.url), { type: "module" })
	return {
		post: (req) => w.postMessage(req),
		onReply: (f) => w.addEventListener("message", (e: MessageEvent<JobReply>) => f(e.data)),
		onError(f) {
			w.addEventListener("error", () => f())
			w.addEventListener("messageerror", () => f())
		},
		terminate: () => w.terminate(),
	}
}

const quantity = z.union([
	z.string().regex(/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/),
	z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
])
const blockData = z.object({
	result: z.object({
		blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
		header: z.object({ globalVariables: z.object({ timestamp: quantity }) }),
	}),
})

/** The latest block's hash and timestamp, from one answer. */
async function latestBlock(nodeUrl: string, fetchFn: typeof fetch): Promise<{ hash: Hex; timestamp: bigint }> {
	const res = await fetchFn(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getBlockData", params: ["latest"] }),
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
	})
	if (!res.ok) throw new Error(`node_getBlockData: HTTP ${res.status}`)
	const parsed = blockData.safeParse(await res.json())
	if (!parsed.success) throw new Error("node_getBlockData: unexpected answer")
	const { blockHash, header } = parsed.data.result
	return { hash: blockHash as Hex, timestamp: BigInt(header.globalVariables.timestamp) }
}

/** A failure that closes a list until Check again: all but an unavailable one, which a refresh reads again. */
const HELD: ReadonlySet<AllowListCode> = new Set(["LIST_TIMEOUT", "LIST_MISMATCH", "LIST_OVERSIZED", "LIST_CANCELLED"])

const FROM_WORKER: Record<ListFailure, AllowListCode> = {
	MISMATCH: "LIST_MISMATCH",
	OVERSIZED: "LIST_OVERSIZED",
	NOT_LOADED: "LIST_UNAVAILABLE",
}

const backoff = (attempts: number) => Math.min(BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS)

type Held = { code: AllowListCode; at: number }

class StackAllowList implements AllowListPort {
	private readonly fetchFn: typeof fetch
	private readonly listeners = new Set<(p: AllowListProgress | null) => void>()
	/** Failures by roots key until a Check again clears them; `attempts` outlives the clear, so the backoff grows. */
	private readonly failures = new Map<string, Held>()
	private readonly attempts = new Map<string, number>()
	private worker: JobWorker | null = null
	/** The roots key of the list the worker holds. */
	private loaded: string | null = null
	/** The running check's abort, and where the worker's next answer goes. */
	private active: AbortController | null = null
	private answer: ((reply: JobReply) => void) | null = null
	/** Bumped by Cancel, so a check queued before it never starts. */
	private generation = 0
	private queue: Promise<unknown> = Promise.resolve()

	constructor(private readonly d: AllowListDeps) {
		// Called as a method, the browser's `fetch` throws unless its receiver is the global.
		this.fetchFn = d.fetch ?? ((input, init) => fetch(input, init))
	}

	async current(): Promise<AllowListView> {
		const block = await latestBlock(this.d.nodeUrl, this.fetchFn)
		const record = await readRootRecord({ aztecNode: this.d.nodeUrl, registry: this.d.registry, at: block.hash })
		return { record, nowSec: block.timestamp }
	}

	check(view: AllowListView, label: bigint, origin: Origin): Promise<LabelCheck> {
		const mine = this.generation
		const job = this.queue.then(() => {
			if (mine !== this.generation) throw new AllowListError("LIST_CANCELLED")
			return this.run(view, label, origin)
		})
		this.queue = job.catch(() => {})
		return job
	}

	onProgress(f: (p: AllowListProgress | null) => void): () => void {
		this.listeners.add(f)
		return () => void this.listeners.delete(f)
	}

	cancel(): void {
		this.generation++
		this.worker?.terminate()
		this.worker = null
		this.loaded = null
		this.active?.abort()
	}

	checkAgain(view: AllowListView): boolean {
		const key = rootsKey(view.record)
		const held = this.failures.get(key)
		if (held && this.waitLeft(key, held) > 0) return false
		this.failures.delete(key)
		return true
	}

	private progress(p: AllowListProgress | null): void {
		for (const f of [...this.listeners]) f(p)
	}

	private live(): JobWorker {
		if (this.worker) return this.worker
		const w = this.d.worker()
		w.onReply((reply) => {
			if (w !== this.worker) return
			if (reply.kind === "progress") this.progress({ hashed: reply.hashed, total: reply.total })
			else this.answer?.(reply)
		})
		// A dead worker never answers: the waiting check fails as unavailable, and the next one starts afresh.
		w.onError(() => {
			if (w !== this.worker) return
			w.terminate()
			this.worker = null
			this.loaded = null
			this.answer?.({ kind: "failed", failure: "NOT_LOADED" })
		})
		this.worker = w
		return w
	}

	/** The worker's answer to `req`; a failure it reports also drops the list it held. */
	private async ask(req: JobRequest, signal: AbortSignal): Promise<Exclude<JobReply, { kind: "failed" | "progress" }>> {
		const reply = await new Promise<JobReply>((resolve, reject) => {
			if (signal.aborted) return reject(new AllowListError("LIST_CANCELLED"))
			this.answer = resolve
			signal.addEventListener("abort", () => reject(new AllowListError("LIST_CANCELLED")), { once: true })
			this.live().post(req)
		})
		if (reply.kind === "progress") throw new AllowListError("LIST_UNAVAILABLE")
		if (reply.kind !== "failed") return reply
		this.loaded = null
		throw new AllowListError(FROM_WORKER[reply.failure])
	}

	/** How long a Check again of `key`'s list must still wait; a stopped check waits for nothing. */
	private waitLeft(key: string, held: Held): number {
		const wait = held.code === "LIST_CANCELLED" ? 0 : backoff(this.attempts.get(key) ?? 0)
		return Math.max(0, held.at + wait - this.d.timer.now())
	}

	private failed(key: string, code: AllowListCode): AllowListError {
		if (!HELD.has(code)) return new AllowListError(code)
		if (code !== "LIST_CANCELLED") this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1)
		const held = { code, at: this.d.timer.now() }
		this.failures.set(key, held)
		return new AllowListError(code, this.waitLeft(key, held))
	}

	/** The snapshot of `view`'s roots, from the record's own sequence; after a 404, once more from the latest record's. */
	private async snapshotText(view: AllowListView, key: string, signal: AbortSignal): Promise<string> {
		const url = (sequence: bigint) => `${this.d.botUrl}/v1/snapshots/${sequence}`
		const deps = { fetch: this.fetchFn, timer: this.d.timer, signal, ...(this.d.limits ? { limits: this.d.limits } : {}) }
		const text = await downloadSnapshot(url(view.record.sequence), deps)
		if (text !== null) return text
		// After a restart the bot serves only what it posts next; a heartbeat keeps the roots.
		const latest = await readRootRecord({ aztecNode: this.d.nodeUrl, registry: this.d.registry }).catch(() => null)
		if (latest === null || rootsKey(latest) !== key) throw new AllowListError("LIST_UNAVAILABLE")
		const again = await downloadSnapshot(url(latest.sequence), deps)
		if (again === null) throw new AllowListError("LIST_UNAVAILABLE")
		return again
	}

	private async ensureLoaded(view: AllowListView, key: string, signal: AbortSignal): Promise<void> {
		if (this.loaded === key) return
		this.loaded = null
		const text = await this.snapshotText(view, key, signal)
		await this.ask({ kind: "load", key, text, roots: view.record }, signal)
		this.loaded = key
	}

	private async run(view: AllowListView, label: bigint, origin: Origin): Promise<LabelCheck> {
		const key = rootsKey(view.record)
		const held = this.failures.get(key)
		if (held) throw new AllowListError(held.code, this.waitLeft(key, held))
		const abort = new AbortController()
		this.active = abort
		// Shown, with its Cancel, from the start: the download and the load come before any hash.
		this.progress({ hashed: 0, total: 0 })
		try {
			await this.ensureLoaded(view, key, abort.signal)
			const nowSec = view.nowSec + PROVING_BUDGET_SEC
			const reply = await this.ask({ kind: "check", key, record: view.record, label, origin, nowSec }, abort.signal)
			if (reply.kind !== "checked") throw new AllowListError("LIST_UNAVAILABLE")
			return reply.result
		} catch (err) {
			throw this.failed(key, err instanceof AllowListError ? err.code : "LIST_UNAVAILABLE")
		} finally {
			this.active = null
			this.answer = null
			this.progress(null)
		}
	}
}

export const stackAllowList = (d: AllowListDeps): AllowListPort => new StackAllowList(d)
