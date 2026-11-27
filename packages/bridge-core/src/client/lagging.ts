import type { Transport } from "viem"

/** A header the endpoint does not serve yet: the backend a load balancer picked is behind the block a read needs. */
export class BlockNotServedError extends Error {
	override readonly name = "BlockNotServedError"
	constructor(readonly block: bigint | "latest") {
		super(`block ${block} is not served yet`)
	}
}

/**
 * What a load-balanced public endpoint answers when the backend it picked is behind the block a read
 * names, as publicnode's Sepolia endpoint words it. Nothing else is retried: a local chain never
 * answers these, so its behaviour does not change.
 */
const LAGGING: readonly { code: number; text: RegExp }[] = [
	// eth_call or eth_getBlock* at a block number or hash past this backend's head (EIP-1474 "resource not found").
	{ code: -32001, text: /^block not found\b/ },
	// eth_getLogs whose toBlock is past this backend's head.
	{ code: -32602, text: /^block range extends beyond current head block\b/ },
]

/** Bounds the cause walk; a viem chain is three or four links deep. */
const MAX_DEPTH = 8

/**
 * Whether `e` is a lagging backend's answer: a {@link BlockNotServedError}, or one of the exact
 * provider codes and messages above anywhere along its cause chain. Matched by shape, never by
 * class: another copy of viem builds the same fields on its own classes.
 */
export function isLagging(e: unknown): boolean {
	let x: unknown = e
	for (let depth = 0; typeof x === "object" && x !== null && depth < MAX_DEPTH; depth++) {
		if (x instanceof BlockNotServedError) return true
		const { code, details, message, cause } = x as { code?: unknown; details?: unknown; message?: unknown; cause?: unknown }
		const text = typeof details === "string" ? details : typeof message === "string" ? message : ""
		if (typeof code === "number" && LAGGING.some((l) => l.code === code && l.text.test(text))) return true
		x = cause
	}
	return false
}

/** A read that fails as a lagging backend's this many more times than once rejects. */
export const LAGGING_RETRIES = 3

/**
 * `read`, retried up to {@link LAGGING_RETRIES} times `intervalMs` apart while it fails as
 * {@link isLagging}. Any other error, and a fourth lagging failure, rejects as the read threw it.
 */
export async function retryLagging<T>(intervalMs: number, read: () => Promise<T>): Promise<T> {
	for (let retries = 0; ; retries++) {
		try {
			return await read()
		} catch (e) {
			if (retries === LAGGING_RETRIES || !isLagging(e)) throw e
			await new Promise((r) => setTimeout(r, intervalMs))
		}
	}
}

/** The reads that name a block. Nothing that sends is ever retried. */
const BLOCK_READS: ReadonlySet<string> = new Set([
	"eth_call",
	"eth_getLogs",
	"eth_getBlockByNumber",
	"eth_getBlockByHash",
	"eth_getStorageAt",
	"eth_getCode",
	"eth_getBalance",
	"eth_getTransactionCount",
])

/** `transport` with {@link retryLagging} on every block-naming read, `intervalMs` apart. */
export function laggingTolerant<T extends Transport>(transport: T, intervalMs: number): T {
	return ((args: Parameters<T>[0]) => {
		const t = transport(args)
		const request: typeof t.request = (r, o) =>
			BLOCK_READS.has(r.method) ? retryLagging(intervalMs, () => t.request(r, o)) : t.request(r, o)
		return { ...t, request }
	}) as T
}
