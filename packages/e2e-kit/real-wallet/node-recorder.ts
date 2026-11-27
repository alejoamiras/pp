/**
 * A recording reverse proxy in front of the stack's Aztec node, given to the wallet as its network
 * URL. It forwards every request unchanged and records each JSON-RPC call (batches unwrapped): the
 * method, small params, whether a nullifier witness came back, and the hash of each `node_sendTx`,
 * parsed with stdlib's own `Tx` schema. Responses are relayed byte for byte.
 */
import { createServer, type IncomingMessage, request } from "node:http"
import type { Socket } from "node:net"

export interface NodeCall {
	seq: number
	method: string
	/** Kept when it serializes to at most 4 KiB. */
	params?: unknown
	/** `node_getNullifierMembershipWitness` only: whether the node returned a witness. */
	found?: boolean
	/** `node_sendTx` only. */
	txHash?: string
	error?: string
}

export interface NodeRecorder {
	url: string
	port: number
	calls(): NodeCall[]
	sentTxHashes(): string[]
	nullifierQueries(): { value: string; found: boolean; seq: number }[]
	close(): Promise<void>
}

type TxHashOf = (param: unknown) => Promise<string>

const MAX_BODY = 64 * 2 ** 20
const SMALL_PARAMS = 4096
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "upgrade"])

const stdlibTxHash: TxHashOf = async (param) => {
	const { Tx } = await import("@aztec-labs/stdlib/tx")
	return (await Tx.schema.parseAsync(param)).getTxHash().toString()
}

async function readCapped(stream: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = []
	let n = 0
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		n += chunk.length
		if (n > MAX_BODY) throw new Error(`node recorder: body above ${MAX_BODY} bytes`)
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

function forward(
	target: URL,
	req: IncomingMessage,
	body: Buffer,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
	const headers: Record<string, string> = { "content-length": String(body.length) }
	for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") headers[k] = v
	return new Promise((resolve, reject) => {
		const out = request(target, { method: req.method, headers }, (res) => {
			readCapped(res)
				.then((b) => {
					const h: Record<string, string> = {}
					for (const [k, v] of Object.entries(res.headers)) if (!HOP.has(k) && typeof v === "string") h[k] = v
					resolve({ status: res.statusCode ?? 502, headers: h, body: b })
				})
				.catch(reject)
		})
		out.on("error", reject)
		out.end(body)
	})
}

const parse = (b: Buffer): unknown => {
	try {
		return JSON.parse(b.toString("utf8"))
	} catch {
		return undefined
	}
}

interface RpcMsg {
	id?: unknown
	method?: unknown
	params?: unknown
	result?: unknown
	error?: unknown
}

async function record(calls: NodeCall[], reqJson: unknown, resJson: unknown, txHashOf: TxHashOf): Promise<void> {
	const reqs = (Array.isArray(reqJson) ? reqJson : [reqJson]) as RpcMsg[]
	const ress = (Array.isArray(resJson) ? resJson : [resJson]) as RpcMsg[]
	for (const r of reqs) {
		if (typeof r?.method !== "string") continue
		const res = ress.find((x) => x?.id === r.id)
		const call: NodeCall = { seq: calls.length, method: r.method }
		calls.push(call)
		const params = Array.isArray(r.params) ? r.params : []
		if (JSON.stringify(params).length <= SMALL_PARAMS) call.params = params
		if (res?.error !== undefined) call.error = JSON.stringify(res.error).slice(0, 500)
		if (r.method === "node_getNullifierMembershipWitness") call.found = res?.result != null
		if (r.method === "node_sendTx") call.txHash = await txHashOf(params[0]).catch((e: Error) => `unparsed: ${e.message.slice(0, 200)}`)
	}
}

/** @param target the node's `http://127.0.0.1:<port>` URL */
export async function startNodeRecorder(target: string, txHashOf: TxHashOf = stdlibTxHash): Promise<NodeRecorder> {
	const upstream = new URL(target)
	const calls: NodeCall[] = []
	const sockets = new Set<Socket>()
	const server = createServer((req, res) => {
		void (async () => {
			const body = await readCapped(req)
			const up = await forward(new URL(req.url ?? "/", upstream), req, body)
			await record(calls, parse(body), parse(up.body), txHashOf)
			res.writeHead(up.status, { ...up.headers, "content-length": String(up.body.length) })
			res.end(up.body)
		})().catch((e: Error) => {
			calls.push({ seq: calls.length, method: "(proxy)", error: e.message.slice(0, 500) })
			if (!res.headersSent) res.writeHead(502)
			res.end()
		})
	})
	server.on("connection", (s) => {
		sockets.add(s)
		s.on("close", () => sockets.delete(s))
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address()
	if (!addr || typeof addr === "string") throw new Error("node recorder: no TCP address")
	return {
		url: `http://127.0.0.1:${addr.port}`,
		port: addr.port,
		calls: () => calls.map((c) => ({ ...c })),
		sentTxHashes: () => calls.filter((c) => c.method === "node_sendTx").map((c) => c.txHash ?? ""),
		nullifierQueries: () =>
			calls
				.filter((c) => c.method === "node_getNullifierMembershipWitness" && Array.isArray(c.params))
				.map((c) => ({ value: String((c.params as unknown[])[1]), found: c.found === true, seq: c.seq })),
		close: () =>
			new Promise((resolve) => {
				for (const s of sockets) s.destroy()
				server.close(() => resolve())
			}),
	}
}
