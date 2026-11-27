/**
 * A loopback JSON-RPC proxy a rehearsal puts between a CLI and anvil or the Aztec node, to stage what a
 * live endpoint can do: a `finalized` tag far behind `latest`, an Outbox with no root yet, a node that
 * refuses one transaction. Each call is forwarded unchanged unless the rule rewrites or answers it.
 */
import { createServer, type IncomingMessage, type Server } from "node:http"
import { claimPort, releaseNamed } from "@pp/run-isolation/ports"
import { type Address, isAddressEqual, numberToHex, toFunctionSelector } from "viem"

export type RpcCall = { jsonrpc: "2.0"; id: unknown; method: string; params?: unknown[] }
type Answer = { result: unknown } | { error: { code: number; message: string } }

/** A rule's verdict: undefined forwards the call as it came. */
export type Verdict = { forward: RpcCall } | { answer: Answer } | undefined
export type Rule = (call: RpcCall) => Verdict

export type RpcProxy = { url: string; close(): Promise<void> }

/** Response headers that describe the upstream body, which the proxy re-serializes. */
const BODY_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"])

const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})

/** Every call of a body, its verdict, and the upstream answers of those forwarded, in the body's order. */
async function relay(upstream: string, body: string, rule: Rule): Promise<{ status: number; headers: Headers; body: string }> {
	const parsed = JSON.parse(body) as RpcCall | RpcCall[]
	const calls = Array.isArray(parsed) ? parsed : [parsed]
	const verdicts = calls.map((c) => rule(c))
	const forwarded = calls.flatMap((c, i) => {
		const v = verdicts[i]
		return v && "answer" in v ? [] : [v?.forward ?? c]
	})
	let headers = new Headers({ "content-type": "application/json" })
	let status = 200
	const byId = new Map<unknown, unknown>()
	if (forwarded.length) {
		const res = await fetch(upstream, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(Array.isArray(parsed) ? forwarded : forwarded[0]),
		})
		headers = res.headers
		status = res.status
		const answered = (await res.json()) as { id: unknown } | { id: unknown }[]
		for (const a of Array.isArray(answered) ? answered : [answered]) byId.set(a.id, a)
	}
	const out = calls.map((c, i) => {
		const v = verdicts[i]
		return v && "answer" in v ? { jsonrpc: "2.0", id: c.id, ...v.answer } : byId.get(c.id)
	})
	return { status, headers, body: JSON.stringify(Array.isArray(parsed) ? out : out[0]) }
}

/**
 * Listens on a loopback port claimed under `runId` and relays each JSON-RPC body to `upstream` through
 * `rule`. `close` stops it and releases the row.
 */
export async function startRpcProxy(o: { runId: string; service: string; upstream: string; rule: Rule }): Promise<RpcProxy> {
	const port = await claimPort(o.runId, o.service)
	const server: Server = createServer((req, res) => {
		void (async () => {
			try {
				const r = await relay(o.upstream, await readBody(req), o.rule)
				const headers = Object.fromEntries([...r.headers].filter(([k]) => !BODY_HEADERS.has(k.toLowerCase())))
				res.writeHead(r.status, headers).end(r.body)
			} catch (e) {
				res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }))
			}
		})()
	})
	const release = () => releaseNamed([{ port, service: o.service, owner: o.runId }])
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(port, "127.0.0.1", () => resolve())
		})
	} catch (e) {
		await release()
		throw e
	}
	return {
		url: `http://127.0.0.1:${port}`,
		async close() {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			if (!(await release())) throw new Error(`the port registry stayed locked; ${port} is still listed for ${o.runId}`)
		},
	}
}

/** Serves `finalized` as the block `pin()` names, when it names one; every other call goes through. */
export const finalizedAt =
	(pin: () => bigint | undefined): Rule =>
	(call) => {
		const at = pin()
		if (call.method !== "eth_getBlockByNumber" || call.params?.[0] !== "finalized" || at === undefined) return undefined
		return { forward: { ...call, params: [numberToHex(at), ...(call.params?.slice(1) ?? [])] } }
	}

const GET_ROOTS = toFunctionSelector("function getRoots(uint256)")
/** `bytes32[32]` of zeros: what `Outbox.getRoots` returns for an epoch no proof has landed for. */
const NO_ROOTS = `0x${"0".repeat(64 * 32)}`

/** Answers every `Outbox.getRoots` read with no roots, so no burn's epoch ever reads as proven. */
export const outboxWithoutRoots =
	(outbox: Address): Rule =>
	(call) => {
		const tx = call.method === "eth_call" ? (call.params?.[0] as { to?: Address; data?: string; input?: string }) : undefined
		const data = tx?.data ?? tx?.input
		if (!tx?.to || !isAddressEqual(tx.to, outbox) || !data?.startsWith(GET_ROOTS)) return undefined
		return { answer: { result: NO_ROOTS } }
	}

/** Refuses the node's `sendTx` while `refuse()` holds, as a node that rejects the transaction would. */
export const refuseSendWhile =
	(refuse: () => boolean): Rule =>
	(call) =>
		call.method === "aztec_sendTx" && refuse()
			? { answer: { error: { code: -32000, message: "the node refused the transaction" } } }
			: undefined
