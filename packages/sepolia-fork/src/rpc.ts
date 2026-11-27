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

export const hostOf = (url: string): string => new URL(url).host

/**
 * `text` with each of `urls` replaced by its host, raw and in the URL-encoded and JSON-escaped forms an
 * error can carry. An endpoint's path or query may hold a key; its host names the provider well enough.
 */
export function scrub(text: string, urls: readonly string[]): string {
	let out = text
	for (const url of urls) {
		const host = hostOf(url)
		for (const form of [url, encodeURIComponent(url), JSON.stringify(url).slice(1, -1)]) out = out.replaceAll(form, host)
	}
	return out
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
				signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
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
				if (!(err instanceof RpcError) || !busy(err) || attempt >= (o.retries ?? 0)) throw err
				await sleep(Math.min(1_000 * 2 ** attempt, 8_000))
			}
		}
	}
}
