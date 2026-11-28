import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export type LoopbackServer = { url: string; close(): Promise<void> }

/** The request body as text. */
export const bodyOf = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		let body = ""
		req.on("data", (chunk) => (body += chunk))
		req.on("end", () => resolve(body))
		req.on("error", reject)
	})

export type Reply = { status: number; body: string }

/** Serves posts on `port` (already claimed by the caller) at 127.0.0.1; `reply` maps one body to its status and body. */
export function serveHttp(port: number, reply: (body: string) => Promise<Reply>): Promise<LoopbackServer> {
	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const r = await reply(await bodyOf(req)).catch(
			(e): Reply => ({ status: 502, body: JSON.stringify({ error: { message: String(e) } }) }),
		)
		res.writeHead(r.status, { "content-type": "application/json" }).end(r.body)
	}
	const server = createServer((req, res) => void handle(req, res))
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () =>
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise((r) => {
						server.close(() => r())
						server.closeAllConnections()
					}),
			}),
		)
	})
}

/** Serves JSON-RPC posts on `port` (already claimed by the caller) at 127.0.0.1; `answer` maps one parsed body to its reply. */
export const serveJsonRpc = (port: number, answer: (body: unknown) => Promise<unknown>): Promise<LoopbackServer> =>
	serveHttp(port, async (body) => ({ status: 200, body: JSON.stringify(await answer(JSON.parse(body))) }))

/** `answer` over one call or a batch, as the body came. */
export const eachCall =
	<C>(answer: (call: C) => Promise<unknown> | unknown) =>
	async (body: unknown): Promise<unknown> =>
		Array.isArray(body) ? Promise.all((body as C[]).map(answer)) : answer(body as C)
