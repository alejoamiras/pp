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

type Request = (args: { method: string; params?: unknown }, options?: never) => Promise<unknown>
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
 * `transport` with each `eth_sendRawTransaction` offered again, as the identical request object it was
 * handed, while the endpoint refuses it as rate-limited: up to {@link SEND_ATTEMPTS} attempts,
 * `delayMs`, then twice and four times that apart. Nothing is signed, estimated or numbered here, so
 * every attempt carries the same bytes and hash. Any other error rejects at once; after the last
 * refusal the first one rejects. Every other method passes through untouched.
 */
export function sendRetrying<T extends TransportLike>(transport: T, delayMs = 1_000): T {
	return ((args: never) => {
		const t = transport(args)
		const request: Request = (r, o) => (r.method === "eth_sendRawTransaction" ? offer(() => t.request(r, o), delayMs) : t.request(r, o))
		return { ...t, request }
	}) as T
}
