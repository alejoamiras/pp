/**
 * The operator's limits on its ASP API, kept by the proxy for a pool that is not ours: at most one
 * upstream request per exact URL per five minutes (the public key, per hour), whatever its outcome,
 * every caller in a window sharing its one request, and the leaves asked again only once the root
 * answer differs from the one they were asked under. Per server process, in memory only.
 */
import type { AspKind, Forwarded } from "./proxy"

export const WINDOW_MS = 5 * 60_000
export const PUBLIC_KEY_MS = 60 * 60_000
/** The proxy forwards one spelling per route, so a target names four URLs; the cap only stops a bug growing the map. */
export const MAX_URLS = 8

export type AllowedKind = Exclude<AspKind, "note-events">

interface Window {
	at: number
	answer: Promise<Forwarded>
	/** Leaves only: the root answer current when they were requested. */
	underRoot?: Uint8Array
	/** Leaves only, set once the answer is a 200 of the leaves' shape: only then does it outlive its window. */
	kept?: true
}

const DECIMAL = /^[0-9]{1,78}$/
const ROOT = /^(?:[0-9]{1,78}|0x[0-9a-fA-F]{1,64})$/

/** A 200 that can stand for its kind past its window: `{ root }` or `{ leaves }` as the ASP API writes them. */
function shaped(kind: "root" | "leaves", body: Uint8Array): boolean {
	let v: unknown
	try {
		v = JSON.parse(Buffer.from(body).toString("utf8"))
	} catch {
		return false
	}
	if (typeof v !== "object" || v === null) return false
	if (kind === "root") {
		const root = (v as { root?: unknown }).root
		return typeof root === "string" && ROOT.test(root)
	}
	const leaves = (v as { leaves?: unknown }).leaves
	return Array.isArray(leaves) && leaves.every((l) => typeof l === "string" && DECIMAL.test(l))
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a !== undefined && b !== undefined && Buffer.from(a).equals(b)

/**
 * `ask(url, kind)` answers from the window `url` is in, or asks `fetchUp` once and opens a new one. An
 * expired leaves window first refreshes `rootUrl` through its own window, so leaves follow the root even
 * for a page that never asks for it. `fetchUp` must resolve to a failure rather than reject; a rejection
 * is taken as one. `now` must be monotonic.
 */
export function aspAllowance(fetchUp: (url: string) => Promise<Forwarded>, rootUrl: string, now: () => number = () => performance.now()) {
	const windows = new Map<string, Window>()
	let root: Uint8Array | undefined
	const fresh = (w: Window, kind: AllowedKind) => now() - w.at < (kind === "public-key" ? PUBLIC_KEY_MS : WINDOW_MS)

	function open(url: string, kind: AllowedKind): Promise<Forwarded> {
		if (!windows.has(url) && windows.size >= MAX_URLS) return Promise.resolve({ ok: false, reason: `over ${MAX_URLS} ASP URLs` })
		const w: Window = {
			at: now(),
			answer: fetchUp(url).catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) })),
			underRoot: kind === "leaves" ? root : undefined,
		}
		windows.set(url, w)
		void w.answer.then((r) => {
			if (!r.ok || r.status !== 200 || (kind !== "root" && kind !== "leaves") || !shaped(kind, r.body)) return
			if (kind === "leaves") w.kept = true
			else if (windows.get(url) === w) root = r.body
		})
		return w.answer
	}

	async function leaves(url: string): Promise<Forwarded> {
		await ask(rootUrl, "root")
		// Re-read: a caller that awaited the same root may have opened a new window meanwhile.
		const w = windows.get(url)
		if (w && (fresh(w, "leaves") || (w.kept && same(w.underRoot, root)))) return w.answer
		return open(url, "leaves")
	}

	function ask(url: string, kind: AllowedKind): Promise<Forwarded> {
		const w = windows.get(url)
		if (w && fresh(w, kind)) return w.answer
		return kind === "leaves" ? leaves(url) : open(url, kind)
	}
	return ask
}
