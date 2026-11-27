/**
 * A loopback JSON-RPC front for one anvil that answers the way a load-balanced public backend can: it
 * counts nonces without the pending pool, keeps a send in a pool of its own that never reaches a block,
 * or serves `finalized` stuck at one block. Each rule is off until a case sets it, and a case may change
 * one while a CLI runs.
 */
import { type Hash, type Hex, hexToNumber, keccak256, numberToHex, parseTransaction } from "viem"
import { eachCall, type LoopbackServer, serveJsonRpc } from "./loopback"

export type ProxyRules = {
	/** `eth_getTransactionCount` at `pending` answers the mined count: this backend has no view of any pool. */
	pendingAsLatest?: boolean
	/**
	 * A raw transaction at this nonce is acknowledged with its hash and never relayed, as by a backend
	 * whose pool holds it while no block ever does; it still counts in this backend's `pending` nonce.
	 */
	dropNonce?: number
	/** `eth_getBlockByNumber("finalized")` answers this block: finality has stalled there. */
	finalizedAt?: bigint
}

export type Dropped = { hash: Hash; nonce: number }

export type RpcProxy = LoopbackServer & { rules: ProxyRules; dropped: Dropped[] }

type Call = { jsonrpc: "2.0"; id: unknown; method: string; params?: unknown[] }
type Rewritten = { forward: Call; adjust?: (result: Hex) => Hex } | { result: unknown }

function rewriteCount(call: Call, rules: ProxyRules, dropped: readonly Dropped[]): Rewritten {
	const [address, tag] = call.params ?? []
	if (tag !== "pending") return { forward: call }
	if (rules.pendingAsLatest) return { forward: { ...call, params: [address, "latest"] } }
	const held = Math.max(-1, ...dropped.map((d) => d.nonce)) + 1
	return { forward: call, adjust: (result) => numberToHex(Math.max(hexToNumber(result), held)) }
}

/** The call to forward, possibly with its result adjusted, or the answer this backend gives on its own. */
function rewrite(call: Call, rules: ProxyRules, dropped: Dropped[]): Rewritten {
	const params = call.params ?? []
	if (call.method === "eth_getTransactionCount") return rewriteCount(call, rules, dropped)
	if (call.method === "eth_getBlockByNumber" && params[0] === "finalized" && rules.finalizedAt !== undefined)
		return { forward: { ...call, params: [numberToHex(rules.finalizedAt), ...params.slice(1)] } }
	const raw = params[0] as Hex
	if (call.method === "eth_sendRawTransaction" && rules.dropNonce !== undefined && parseTransaction(raw).nonce === rules.dropNonce) {
		dropped.push({ hash: keccak256(raw), nonce: rules.dropNonce })
		return { result: keccak256(raw) }
	}
	return { forward: call }
}

/** Serves on `port` (already claimed) at 127.0.0.1, in front of `upstream`. */
export async function startRpcProxy(upstream: string, port: number): Promise<RpcProxy> {
	const rules: ProxyRules = {}
	const dropped: Dropped[] = []
	const server = await serveJsonRpc(
		port,
		eachCall(async (call: Call) => {
			const r = rewrite(call, rules, dropped)
			if ("result" in r) return { jsonrpc: "2.0", id: call.id, result: r.result }
			const res = await fetch(upstream, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(r.forward),
			})
			const body = (await res.json()) as { result?: Hex }
			return r.adjust && typeof body.result === "string" ? { ...body, result: r.adjust(body.result) } : body
		}),
	)
	return { ...server, rules, dropped }
}
