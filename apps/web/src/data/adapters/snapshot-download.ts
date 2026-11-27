/**
 * Downloads one snapshot's text from the bot. The bounds are on the download only: its bytes, counted
 * as they arrive (a Content-Length is the server's claim, and a compressed body is longer once
 * decoded), a wait between chunks and a wait for the whole body. The hashing that follows has no
 * deadline, which would refuse a legal list on a slow device.
 */
import { MAX_LEAVES } from "@pp/label-paths"
import { AllowListError } from "../errors"
import type { Timer } from "../ports"

/**
 * The wire format at its largest: both lists at `MAX_LEAVES` leaves, each a quoted 77-digit decimal
 * (p has 77 digits) and its comma, 80 bytes; a kibibyte covers the keys, the roots and the sequence.
 */
export const MAX_SNAPSHOT_BYTES = 2 * MAX_LEAVES * 80 + 1024

export interface DownloadLimits {
	maxBytes: number
	/** Longest wait for the response, then between two chunks. */
	idleMs: number
	totalMs: number
}

/** About 1.2 Mbit/s for a maximal list, with half a minute of silence allowed at any point. */
export const DOWNLOAD_LIMITS: DownloadLimits = { maxBytes: MAX_SNAPSHOT_BYTES, idleMs: 30_000, totalMs: 300_000 }

export interface DownloadDeps {
	fetch: typeof fetch
	timer: Timer
	limits?: DownloadLimits
	/** Aborts the download, which rejects with `LIST_CANCELLED`. */
	signal?: AbortSignal
}

/**
 * The body at `url`, or `null` on a 404 (the bot does not hold that sequence).
 * @throws AllowListError `LIST_TIMEOUT`, `LIST_OVERSIZED`, `LIST_MISMATCH` (not UTF-8), `LIST_CANCELLED`, or `LIST_UNAVAILABLE`
 */
export async function downloadSnapshot(url: string, d: DownloadDeps): Promise<string | null> {
	const limits = d.limits ?? DOWNLOAD_LIMITS
	const abort = new AbortController()
	const stop = new AbortController()
	let failure: AllowListError | null = null
	const fail = (e: AllowListError) => {
		failure ??= e
		abort.abort()
	}
	const onCancel = () => fail(new AllowListError("LIST_CANCELLED"))
	if (d.signal?.aborted) throw new AllowListError("LIST_CANCELLED")
	d.signal?.addEventListener("abort", onCancel, { once: true })
	void d.timer.sleep(limits.totalMs, stop.signal).then((elapsed) => elapsed && fail(new AllowListError("LIST_TIMEOUT")))
	let idle = new AbortController()
	const arm = () => {
		idle.abort()
		idle = new AbortController()
		void d.timer.sleep(limits.idleMs, idle.signal).then((elapsed) => elapsed && fail(new AllowListError("LIST_TIMEOUT")))
	}
	try {
		arm()
		const aborted = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason)))
		aborted.catch(() => {})
		const request = d.fetch(url, { signal: abort.signal, cache: "no-store", redirect: "error", credentials: "omit" })
		const res = await Promise.race([request, aborted])
		// A discarded body is cancelled, or it keeps streaming past the limits that no longer watch it.
		if (res.status === 404 || !res.ok || !res.body) void res.body?.cancel().catch(() => {})
		if (res.status === 404) return null
		if (!res.ok || !res.body) throw new AllowListError("LIST_UNAVAILABLE")
		return await readCapped(res.body, limits.maxBytes, abort.signal, arm)
	} catch (err) {
		throw failure ?? (err instanceof AllowListError ? err : new AllowListError("LIST_UNAVAILABLE"))
	} finally {
		stop.abort()
		idle.abort()
		d.signal?.removeEventListener("abort", onCancel)
	}
}

/** A cancelled read ends like a finished one, so `signal` is checked after every read. */
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal, onChunk: () => void): Promise<string> {
	const reader = body.getReader()
	const onAbort = () => void reader.cancel().catch(() => {})
	signal.addEventListener("abort", onAbort, { once: true })
	const decoder = new TextDecoder("utf-8", { fatal: true })
	const parts: string[] = []
	let bytes = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (signal.aborted) throw new AllowListError("LIST_UNAVAILABLE")
			if (done) break
			onChunk()
			bytes += value.byteLength
			if (bytes > maxBytes) throw new AllowListError("LIST_OVERSIZED")
			parts.push(decode(decoder, value))
		}
		parts.push(decode(decoder))
		return parts.join("")
	} catch (err) {
		void reader.cancel().catch(() => {})
		throw err
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

function decode(decoder: TextDecoder, chunk?: Uint8Array): string {
	try {
		return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
	} catch {
		throw new AllowListError("LIST_MISMATCH")
	}
}
