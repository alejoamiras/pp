type RpcReply<T> = { result?: T; error?: { code: number; message: string } }

/** One JSON-RPC call to an Aztec node; a JSON-RPC error becomes a thrown `Error` naming the method. */
export async function nodeRpc<T>(nodeUrl: string, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
	const res = await fetch(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal,
	})
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
	const reply = (await res.json()) as RpcReply<T>
	if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
	return reply.result as T
}

export type NodeInfo = { l1ChainId: number; l1ContractAddresses: { rollupAddress: `0x${string}` } }

export const nodeInfo = (nodeUrl: string) => nodeRpc<NodeInfo>(nodeUrl, "node_getNodeInfo")
