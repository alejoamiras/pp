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
	/** Set once the answer is a 200 (of its kind's shape, for the root and the leaves). */
	good?: true
	/** Leaves only: the root answer their request was made under, if the root's window had a good one. */
	underRoot?: Uint8Array
}

const DECIMAL = /^[0-9]{1,78}$/
const ROOT = /^(?:[0-9]{1,78}|0x[0-9a-fA-F]{1,64})$/
/** The pinned SDK refuses more: 2 ** its ASSOCIATION_SET_MAX_DEPTH (18). */
const MAX_LEAVES = 2 ** 18

/** Why a 200 for the root or the leaves is unusable as the ASP API writes them, or `null`. */
function malformed(kind: "root" | "leaves", body: Uint8Array): string | null {
	let v: unknown
	try {
		v = JSON.parse(Buffer.from(body).toString("utf8"))
	} catch {
		return `the ${kind} answer is not JSON`
	}
	const field = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[kind] : undefined
	if (kind === "root") return typeof field === "string" && ROOT.test(field) ? null : "the root answer has no decimal or 0x root"
	if (!Array.isArray(field) || !field.every((l) => typeof l === "string" && DECIMAL.test(l)))
		return "the leaves answer is not a list of decimals"
	return field.length > MAX_LEAVES ? `more than ${MAX_LEAVES} leaves` : null
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => a !== undefined && b !== undefined && Buffer.from(a).equals(b)

/**
 * `ask(url, kind)` for a URL `proxyRoute` rebuilt. A root or leaves 200 of another shape is a failure, so
 * it never outlives its window. An expired leaves window refreshes `rootUrl` through the root's own window
 * first: the page checks leaves against the chain and need not ask for the root, so leaves would otherwise
 * never follow a root change. A rejected `fetchUp` counts as a failure. `now` must be monotonic.
 */
export function aspAllowance(fetchUp: (url: string) => Promise<Forwarded>, rootUrl: string, now: () => number = () => performance.now()) {
	const windows = new Map<string, Window>()
	let root: Uint8Array | undefined
	const fresh = (w: Window, kind: AllowedKind) => now() - w.at < (kind === "public-key" ? PUBLIC_KEY_MS : WINDOW_MS)

	async function upstream(url: string, kind: AllowedKind): Promise<Forwarded> {
		const r = await fetchUp(url).catch(
			(err: unknown): Forwarded => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
		)
		const bad = r.ok && r.status === 200 && (kind === "root" || kind === "leaves") ? malformed(kind, r.body) : null
		return bad === null ? r : { ok: false, reason: bad }
	}

	function open(url: string, kind: AllowedKind, underRoot?: Uint8Array): Promise<Forwarded> {
		if (!windows.has(url) && windows.size >= MAX_URLS) return Promise.resolve({ ok: false, reason: `over ${MAX_URLS} ASP URLs` })
		const w: Window = { at: now(), answer: upstream(url, kind), underRoot }
		windows.set(url, w)
		void w.answer.then((r) => {
			if (!r.ok || r.status !== 200) return
			w.good = true
			if (kind === "root" && windows.get(url) === w) root = r.body
		})
		return w.answer
	}

	async function leaves(url: string): Promise<Forwarded> {
		await ask(rootUrl, "root")
		// Re-read: a caller that awaited the same root may have opened a new window meanwhile.
		const w = windows.get(url)
		if (w && (fresh(w, "leaves") || (w.good && same(w.underRoot, root)))) return w.answer
		return open(url, "leaves", windows.get(rootUrl)?.good ? root : undefined)
	}

	function ask(url: string, kind: AllowedKind): Promise<Forwarded> {
		const w = windows.get(url)
		if (w && fresh(w, kind)) return w.answer
		return kind === "leaves" ? leaves(url) : open(url, kind)
	}
	return ask
}
