/** One JSON-RPC call; rejects with an {@link RpcError} that names hosts, never a full URL. */
export type Rpc = <T = unknown>(method: string, params?: unknown[]) => Promise<T>

export class RpcError extends Error {
	readonly host: string
	readonly code: number | undefined
	constructor(host: string, message: string, code?: number) {
		super(message)
		this.name = "RpcError"
		this.host = host
		this.code = code
	}
}

/** Never throws: a failure message about an unparseable endpoint must not carry the endpoint either. */
export const hostOf = (url: string): string => URL.parse(url)?.host ?? "<unparseable endpoint>"

/**
 * `text` with each of `urls` replaced by its host, as given and as `URL` normalizes it, raw and in the
 * URL-encoded and JSON-escaped forms an error can carry; then any part of it left on its own. An endpoint's
 * path, query or userinfo may hold a key; its host names the provider well enough.
 */
export function scrub(text: string, urls: readonly string[]): string {
	let out = text
	for (const url of urls) {
		const host = hostOf(url)
		const parsed = URL.parse(url)
		const spellings = parsed ? [url, parsed.href] : [url]
		for (const s of spellings)
			for (const form of [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]) out = out.replaceAll(form, host)
		for (const part of parsed ? secretParts(parsed) : []) out = out.replaceAll(part, "<hidden>")
	}
	return out
}

const decoded = (s: string): string => {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

/**
 * What a provider can echo on its own, longest first: the path and query together and apart, and each
 * credential, path segment and query value both as the URL encodes it and decoded. Shorter parts are no key,
 * and replacing them would garble the message.
 */
function secretParts(u: URL): string[] {
	const values = u.search
		.slice(1)
		.split("&")
		.map((kv) => kv.slice(kv.indexOf("=") + 1))
	const raw = [u.username, u.password, ...u.pathname.split("/"), ...values]
	const parts = [`${u.pathname}${u.search}`, u.pathname, u.search, ...raw.flatMap((p) => [p, decoded(p)]), ...u.searchParams.values()]
	return [...new Set(parts)].filter((p) => p.length >= 6).sort((a, b) => b.length - a.length)
}

type Options = {
	timeoutMs?: number
	/** Further URLs to keep out of error messages: the endpoint behind a fork, whose errors anvil relays. */
	hide?: readonly string[]
	/**
	 * Attempts after a rate limit or a gateway error, backing off from 1 s and doubling to 8 s: free endpoints
	 * refuse bursts. Anything else fails at once.
	 */
	retries?: number
	fetch?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	/** Ends a call in flight and any further attempt. */
	signal?: AbortSignal
}

/** Direct calls to the endpoint retry as long as the fork's own calls do (anvil `--retries 8`). */
export const ENDPOINT_RETRIES = 8

const BUSY_STATUS = new Set([429, 502, 503, 504])
const BUSY_MESSAGE = /rate.?limit|too many requests/i

const busy = (err: RpcError) => (err.code !== undefined && BUSY_STATUS.has(err.code)) || BUSY_MESSAGE.test(err.message)

export function httpRpc(url: string, o: Options = {}): Rpc {
	const host = hostOf(url)
	const hide = [url, ...(o.hide ?? [])]
	const doFetch = o.fetch ?? fetch
	const sleep = o.sleep ?? Bun.sleep
	type Fail = (why: string, code?: number) => RpcError
	type Body<T> = { result?: T; error?: { code?: number; message?: string } }
	async function post<T>(method: string, params: unknown[], fail: Fail): Promise<Body<T>> {
		try {
			const res = await doFetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
				signal: AbortSignal.any([AbortSignal.timeout(o.timeoutMs ?? 60_000), ...(o.signal ? [o.signal] : [])]),
			})
			if (!res.ok) throw fail(`HTTP ${res.status}`, res.status)
			return (await res.json()) as Body<T>
		} catch (err) {
			if (err instanceof RpcError) throw err
			throw fail(err instanceof Error ? err.message : String(err))
		}
	}
	async function once<T>(method: string, params: unknown[]): Promise<T> {
		const fail: Fail = (why, code) => new RpcError(host, scrub(`${method} at ${host}: ${why}`, hide), code)
		const body = await post<T>(method, params, fail)
		if (body.error) throw fail(body.error.message ?? "error without a message", body.error.code)
		if (body.result === undefined) throw fail("no result")
		return body.result
	}
	return async <T>(method: string, params: unknown[] = []): Promise<T> => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await once<T>(method, params)
			} catch (err) {
				if (!(err instanceof RpcError) || !busy(err) || attempt >= (o.retries ?? 0) || o.signal?.aborted) throw err
				await sleep(Math.min(1_000 * 2 ** attempt, 8_000))
			}
		}
	}
}
