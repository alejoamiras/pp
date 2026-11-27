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

/** Serves JSON-RPC posts on `port` (already claimed by the caller) at 127.0.0.1; `answer` maps one parsed body to its reply. */
export function serveJsonRpc(port: number, answer: (body: unknown) => Promise<unknown>): Promise<LoopbackServer> {
	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const out = await answer(JSON.parse(await bodyOf(req)))
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out))
		} catch (e) {
			res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(e) } }))
		}
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

/** `answer` over one call or a batch, as the body came. */
export const eachCall =
	<C>(answer: (call: C) => Promise<unknown> | unknown) =>
	async (body: unknown): Promise<unknown> =>
		Array.isArray(body) ? Promise.all((body as C[]).map(answer)) : answer(body as C)
