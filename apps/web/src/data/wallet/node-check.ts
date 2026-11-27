import { z } from "zod"
import type { PublicTarget } from "../../build/target"
import { ConnectError } from "./types"

const NODE_TIMEOUT_MS = 10_000

const nodeInfoReply = z.object({
	result: z.object({ l1ChainId: z.number().int(), rollupVersion: z.number().int() }),
})

async function nodeInfo(nodeUrl: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<unknown> {
	const res = await fetchFn(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getNodeInfo", params: [] }),
		cache: "no-store",
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(NODE_TIMEOUT_MS)]),
	})
	if (!res.ok) throw new Error(`node answered HTTP ${res.status}`)
	return res.json()
}

/**
 * Plain JSON-RPC, no Aztec client: the node must name the target's L1 chain and rollup version before
 * the page offers it to a wallet as the chain to connect on.
 *
 * @throws ConnectError `node-unreachable` (no answer, or one that does not parse) or `chain-mismatch`.
 */
export async function assertNodeServesTarget(
	t: Pick<PublicTarget, "nodeUrl" | "l1ChainId" | "rollupVersion">,
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	let reply: unknown
	try {
		reply = await nodeInfo(t.nodeUrl, fetchFn, signal)
	} catch (err) {
		console.error("[pp] node_getNodeInfo failed", err)
		throw new ConnectError("node-unreachable", "The Aztec node does not answer. Check that the network is up, then try again.")
	}
	const parsed = nodeInfoReply.safeParse(reply)
	if (!parsed.success) throw new ConnectError("node-unreachable", "The Aztec node sent an answer this app cannot read.")
	const { l1ChainId, rollupVersion } = parsed.data.result
	if (l1ChainId !== t.l1ChainId || rollupVersion !== t.rollupVersion) {
		throw new ConnectError(
			"chain-mismatch",
			`The Aztec node serves L1 chain ${l1ChainId}, rollup ${rollupVersion}; this app is built for L1 chain ${t.l1ChainId}, rollup ${t.rollupVersion}.`,
		)
	}
}
