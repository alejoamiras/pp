/**
 * The operator's limits on its ASP API, kept by the proxy for a pool that is not ours: at most one
 * upstream request per exact URL per five minutes (the public key, per hour), and the leaves not again
 * while the root answer is byte-identical to the one they were fetched under. A failure or a timeout
 * uses its window like an answer, and every caller in a window shares its one request. In memory only.
 */
import type { AspKind, Forwarded } from "./proxy"

export const WINDOW_MS = 5 * 60_000
export const PUBLIC_KEY_MS = 60 * 60_000
/** The proxy rebuilds every query from the fixed scope, so a target names at most four URLs. */
export const MAX_URLS = 8

export type AllowedKind = Exclude<AspKind, "note-events">

interface Window {
	at: number
	answer: Promise<Forwarded>
	/** Set once the answer is a 200. */
	body?: Uint8Array
	/** For leaves: the root answer current when they were asked for. */
	underRoot?: Uint8Array
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a !== undefined && b !== undefined && Buffer.from(a).equals(b)

/**
 * `ask(url, kind)` answers from the window `url` is in, or asks `fetchUp` once and opens a new one.
 * `fetchUp` must resolve to a failure rather than reject; a rejection is taken as one.
 */
export function aspAllowance(fetchUp: (url: string) => Promise<Forwarded>, now: () => number = Date.now) {
	const windows = new Map<string, Window>()
	let root: Uint8Array | undefined
	return function ask(url: string, kind: AllowedKind): Promise<Forwarded> {
		const w = windows.get(url)
		if (w && now() - w.at < (kind === "public-key" ? PUBLIC_KEY_MS : WINDOW_MS)) return w.answer
		if (kind === "leaves" && w?.body !== undefined && same(w.underRoot, root)) return w.answer
		if (!w && windows.size >= MAX_URLS) return Promise.resolve({ ok: false, reason: `over ${MAX_URLS} ASP URLs` })
		const next: Window = {
			at: now(),
			answer: fetchUp(url).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) })),
			underRoot: kind === "leaves" ? root : undefined,
		}
		windows.set(url, next)
		void next.answer.then((r) => {
			if (!r.ok || r.status !== 200) return
			next.body = r.body
			if (kind === "root" && windows.get(url) === next) root = r.body
		})
		return next.answer
	}
}
