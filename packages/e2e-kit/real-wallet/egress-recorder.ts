/**
 * The browser's only route off its owned loopback ports: an HTTP proxy that answers every request,
 * `CONNECT` or absolute-URI, with 403 and records the target. Chromium sends every non-bypassed
 * request here, offscreen documents included, which Playwright's routing never sees.
 */
import { createServer, type Server, type Socket } from "node:net"

export interface EgressHit {
	seq: number
	/** `host:port` as the browser asked for it. */
	target: string
	method: string
}

export interface Listener {
	port: number
	close(): Promise<void>
}

export interface EgressRecorder extends Listener {
	hits(): EgressHit[]
}

const MAX_HEAD = 16 * 1024
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

function targetOf(method: string, uri: string): string {
	if (method === "CONNECT") return uri
	try {
		const u = new URL(uri)
		return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`
	} catch {
		return `unparsed:${uri.slice(0, 200)}`
	}
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const addr = server.address()
	if (!addr || typeof addr === "string") throw new Error("recorder: no TCP address")
	return addr.port
}

function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
	return () =>
		new Promise((resolve) => {
			for (const s of sockets) s.destroy()
			server.close(() => resolve())
		})
}

export async function startEgressRecorder(): Promise<EgressRecorder> {
	const hits: EgressHit[] = []
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
		socket.on("error", () => {})
		let head = ""
		socket.on("data", (chunk) => {
			head += chunk.toString("latin1")
			const eol = head.indexOf("\r\n")
			if (eol < 0 && head.length < MAX_HEAD) return
			const [method = "", uri = ""] = head.slice(0, eol < 0 ? MAX_HEAD : eol).split(" ")
			hits.push({ seq: hits.length, target: targetOf(method, uri), method })
			socket.removeAllListeners("data")
			socket.end(FORBIDDEN)
		})
	})
	const port = await listen(server)
	return { port, hits: () => [...hits], close: closer(server, sockets) }
}

export type CountingListener = Listener & { connections(): number }

const NO_CONTENT = "HTTP/1.1 204 No Content\r\nCross-Origin-Resource-Policy: cross-origin\r\nConnection: close\r\n\r\n"

async function counting(answer: boolean): Promise<CountingListener> {
	let n = 0
	const sockets = new Set<Socket>()
	const server = createServer((socket) => {
		n++
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
		socket.on("error", () => {})
		if (answer) socket.once("data", () => socket.end(NO_CONTENT))
		else socket.destroy()
	})
	const port = await listen(server)
	return { port, connections: () => n, close: closer(server, sockets) }
}

/** A loopback listener left out of the bypass list: any connection to it proves the fence leaks. */
export const startTripwire = () => counting(false)
/** A loopback listener in the bypass list that answers 204: no connection proves the owned path is broken. */
export const startOwnedProbe = () => counting(true)
