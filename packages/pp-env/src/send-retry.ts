/**
 * EIP-1474 "limit exceeded". Sepolia's Tenderly gateway answers it to an `eth_sendRawTransaction` that
 * follows a burst of reads within about a second, and viem never retries a send.
 */
const LIMIT_EXCEEDED = -32005

/** How many times one send is offered in all: the first attempt and up to three resends. */
export const SEND_ATTEMPTS = 4

/** Bounds the cause walk; a viem error chain is three or four links deep. */
const MAX_DEPTH = 8

/** Whether `e` carries the limit-exceeded code anywhere along its cause chain; matched by shape, so any viem copy's errors match. */
export function isRateLimited(e: unknown): boolean {
	let x: unknown = e
	for (let depth = 0; typeof x === "object" && x !== null && depth < MAX_DEPTH; depth++) {
		if ((x as { code?: unknown }).code === LIMIT_EXCEEDED) return true
		x = (x as { cause?: unknown }).cause
	}
	return false
}

type Args = { method: string; params?: unknown }
type Request = (args: Args, options?: { retryCount?: number }) => Promise<unknown>
type TransportLike = (args: never) => { request: Request }

/** `send`, called again `delayMs`, `2·delayMs`, `4·delayMs` later while it rejects as rate-limited. */
async function offer(send: () => Promise<unknown>, delayMs: number): Promise<unknown> {
	let first: unknown
	for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
		if (attempt > 0) await new Promise((done) => setTimeout(done, delayMs * 2 ** (attempt - 1)))
		try {
			return await send()
		} catch (e) {
			if (!isRateLimited(e)) throw e
			first ??= e
		}
	}
	throw first
}

/**
 * `transport` with each `eth_sendRawTransaction` offered again while the endpoint refuses it as
 * rate-limited: up to {@link SEND_ATTEMPTS} attempts, `delayMs`, then twice and four times that apart.
 * The request is copied once on entry and each attempt sends that copy, with the inner transport's own
 * retries off, so the caller can neither change the bytes between attempts nor multiply the bound.
 * Nothing is signed, estimated or numbered here. Any other error rejects at once; after the last
 * refusal the first one rejects. Every other method passes through untouched.
 */
export function sendRetrying<T extends TransportLike>(transport: T, delayMs = 1_000): T {
	return ((args: never) => {
		const t = transport(args)
		const send = (r: Args, o: Parameters<Request>[1]) => {
			const fixed = { method: r.method, params: Array.isArray(r.params) ? [...r.params] : r.params }
			return offer(() => t.request(fixed, { ...o, retryCount: 0 }), delayMs)
		}
		const request: Request = (r, o) => (r.method === "eth_sendRawTransaction" ? send(r, o) : t.request(r, o))
		return { ...t, request }
	}) as T
}
