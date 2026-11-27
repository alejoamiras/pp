/**
 * Chain time for a stack build: the latest block's timestamp on each chain, and the Aztec node's
 * proven block. Plain JSON-RPC to the Aztec node, so the page loads no Aztec client for it.
 */
import type { PublicClient } from "viem"
import { z } from "zod"
import type { ChainClock } from "../ports"

const NODE_TIMEOUT_MS = 10_000

/** The node writes a bigint as a decimal or 0x string; a number is accepted while it is exact. */
const timestamp = z.union([
	z.string().regex(/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/),
	z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
])
const latestBlock = z.object({ result: z.object({ header: z.object({ globalVariables: z.object({ timestamp }) }) }) })
const blockNumber = z.object({
	result: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^(0|[1-9][0-9]{0,15})$/)]),
})

async function nodeCall<T>(nodeUrl: string, fetchFn: typeof fetch, method: string, params: unknown[], schema: z.ZodType<T>): Promise<T> {
	const res = await fetchFn(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
	})
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
	const parsed = schema.safeParse(await res.json())
	if (!parsed.success) throw new Error(`${method}: unexpected answer`)
	return parsed.data
}

export function stackClock(l1: Pick<PublicClient, "getBlock">, nodeUrl: string, fetchFn: typeof fetch = fetch): ChainClock {
	return {
		aztecNow: async () =>
			BigInt(
				(await nodeCall(nodeUrl, fetchFn, "node_getBlockData", ["latest"], latestBlock)).result.header.globalVariables.timestamp,
			),
		l1Now: async () => (await l1.getBlock({ blockTag: "latest" })).timestamp,
		aztecProven: async () => {
			const n = Number((await nodeCall(nodeUrl, fetchFn, "node_getBlockNumber", ["proven"], blockNumber)).result)
			if (!Number.isSafeInteger(n)) throw new Error("node_getBlockNumber: unexpected answer")
			return n
		},
	}
}
