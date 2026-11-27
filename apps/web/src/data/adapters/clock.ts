/**
 * Chain time for a stack build: the latest block's timestamp on each chain. Plain JSON-RPC to the
 * Aztec node, so the page loads no Aztec client for it.
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

async function aztecLatest(nodeUrl: string, fetchFn: typeof fetch): Promise<bigint> {
	const res = await fetchFn(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getBlockData", params: ["latest"] }),
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.timeout(NODE_TIMEOUT_MS),
	})
	if (!res.ok) throw new Error(`node_getBlockData: HTTP ${res.status}`)
	const parsed = latestBlock.safeParse(await res.json())
	if (!parsed.success) throw new Error("node_getBlockData: no latest block header")
	return BigInt(parsed.data.result.header.globalVariables.timestamp)
}

export function stackClock(l1: Pick<PublicClient, "getBlock">, nodeUrl: string, fetchFn: typeof fetch = fetch): ChainClock {
	return {
		aztecNow: () => aztecLatest(nodeUrl, fetchFn),
		l1Now: async () => (await l1.getBlock({ blockTag: "latest" })).timestamp,
	}
}
