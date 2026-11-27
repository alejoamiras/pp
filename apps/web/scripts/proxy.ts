/**
 * The app server's proxy for a testnet build: the ASP bot's snapshot server and the own pool's mock
 * ASP under the page's origin, so the owner forwards one port. Upstreams are fixed when the server
 * starts. A request picks one of the exact routes below and never a host; it is matched undecoded,
 * and the query that goes up is rebuilt from the values parsed out of it.
 */

export interface ProxyConfig {
	/** The pool's L1 chain, as the SDK puts it in ASP paths and queries. */
	readonly chainId: number
	/** The pool's entrypoint; a query must name it (compared without case). */
	readonly entrypoint: string
	/** Upstream origins, `http://127.0.0.1:<port>`. */
	readonly asp: string
	readonly bot: string
}

export type Upstream = "asp" | "bot"

/** The body of the 502 that stands in for an upstream's unusable answer; the cause goes to the server log. */
export const UPSTREAM_DOWN: Readonly<Record<Upstream, string>> = {
	asp: "the pool's ASP does not answer",
	bot: "the ASP bot does not answer",
}

const DIGITS = /^[0-9]{1,78}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SEQUENCE = /^\/bot\/v1\/snapshots\/(latest|[1-9][0-9]{0,19})$/

type Rule = { required: boolean; check(value: string, c: ProxyConfig): boolean }
const chainRule: Rule = { required: true, check: (v, c) => v === String(c.chainId) }
const entrypointRule: Rule = { required: true, check: (v, c) => ADDRESS.test(v) && v.toLowerCase() === c.entrypoint.toLowerCase() }
const blockRule: Rule = { required: false, check: (v) => DIGITS.test(v) }

/**
 * Each ASP route the mock serves, with its query keys in the order the SDK writes them. `{c}` is the
 * pool's chain id. Anything else, `/admin/*` included, never reaches the mock.
 */
const ASP_ROUTES: ReadonlyArray<{ path: string; query: ReadonlyArray<readonly [string, Rule]> }> = [
	{
		path: "/association-set/root",
		query: [
			["chainId", chainRule],
			["entrypoint", entrypointRule],
		],
	},
	{
		path: "/association-set/leaves",
		query: [
			["chainId", chainRule],
			["entrypoint", entrypointRule],
		],
	},
	{ path: "/public-key", query: [] },
	{ path: "/{c}/public/event-snapshot/payload", query: [["entrypoint", entrypointRule]] },
	{
		path: "/{c}/public/note-events",
		query: [
			["entrypoint", entrypointRule],
			["since", blockRule],
			["until", blockRule],
		],
	},
]

/** `key=value` pairs of plain characters, each key once; `null` for anything else (`%`, `+`, empty pairs). */
function pairs(query: string): Map<string, string> | null {
	const out = new Map<string, string>()
	if (query === "") return out
	for (const pair of query.split("&")) {
		const m = /^([A-Za-z]+)=([0-9A-Za-z]+)$/.exec(pair)
		if (!m || out.has(m[1] as string)) return null
		out.set(m[1] as string, m[2] as string)
	}
	return out
}

/** The rebuilt query, or `null` when `query` names a key the route lacks, misses a required one, or fails a check. */
function rebuild(query: string, rules: ReadonlyArray<readonly [string, Rule]>, c: ProxyConfig): string | null {
	const got = pairs(query)
	if (got === null || [...got.keys()].some((k) => !rules.some(([name]) => name === k))) return null
	const kept: string[] = []
	for (const [name, rule] of rules) {
		const value = got.get(name)
		if (value === undefined) {
			if (rule.required) return null
			continue
		}
		if (!rule.check(value, c)) return null
		kept.push(`${name}=${value}`)
	}
	return kept.length > 0 ? `?${kept.join("&")}` : ""
}

/**
 * The upstream URL for a raw request target (`req.url`, not decoded), or `null` when it is no route
 * of this proxy. The bot drops a query unread, so the proxy drops it too.
 */
export function proxyRoute(rawTarget: string, c: ProxyConfig): { upstream: Upstream; url: string } | null {
	if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) return null
	const q = rawTarget.indexOf("?")
	const path = q === -1 ? rawTarget : rawTarget.slice(0, q)
	const query = q === -1 ? "" : rawTarget.slice(q + 1)
	const seq = SEQUENCE.exec(path)
	if (seq) return { upstream: "bot", url: `${c.bot}/v1/snapshots/${seq[1]}` }
	if (!path.startsWith("/asp/")) return null
	const rest = path.slice("/asp".length)
	for (const route of ASP_ROUTES) {
		const upstreamPath = route.path.replace("{c}", String(c.chainId))
		if (rest !== upstreamPath) continue
		const rebuilt = rebuild(query, route.query, c)
		return rebuilt === null ? null : { upstream: "asp", url: `${c.asp}${upstreamPath}${rebuilt}` }
	}
	return null
}

/** Whether a raw request target falls under the proxy's prefixes, matched or not. */
export const isProxyPath = (rawTarget: string): boolean => /^\/(asp|bot)(\/|\?|$)/.test(rawTarget)

/**
 * Upstream answers the page acts on: 200; 400 for a scope mismatch; 404 for an unknown snapshot after
 * a bot restart, which the page answers by re-reading the latest; and 501, which the mock gives for
 * note events so the SDK scans the chain instead.
 */
const PASSED = new Set([200, 400, 404, 501])

export const DEADLINE_MS = 15_000
export const CAP_BYTES = 16 * 1024 * 1024

export type Forwarded = { ok: true; status: number; body: Uint8Array } | { ok: false; reason: string }

/** The body, or `null` once it passes `cap` bytes (the rest is never read). */
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
	if (body === null) return new Uint8Array()
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.byteLength
		if (size > cap) {
			await reader.cancel()
			return null
		}
		chunks.push(next.value)
	}
	return Buffer.concat(chunks)
}

/**
 * GETs `url` with no header of the client's, following no redirect, within `deadlineMs` for the whole
 * body and `capBytes` of it. Any status outside the passed set is a failure, as is a timeout or overflow.
 */
export async function forward(url: string, o: { deadlineMs?: number; capBytes?: number } = {}): Promise<Forwarded> {
	const cap = o.capBytes ?? CAP_BYTES
	try {
		const res = await fetch(url, {
			method: "GET",
			headers: { accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(o.deadlineMs ?? DEADLINE_MS),
		})
		if (!PASSED.has(res.status)) {
			await res.body?.cancel()
			return { ok: false, reason: `status ${res.status}` }
		}
		const body = await readCapped(res.body, cap)
		return body === null ? { ok: false, reason: `body over ${cap} bytes` } : { ok: true, status: res.status, body }
	} catch (err) {
		const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
		return { ok: false, reason: timedOut ? "timeout" : `unreachable: ${err instanceof Error ? err.message : String(err)}` }
	}
}
