import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { HTTPClient } from "@0xbow/privacy-pools-v2-sdk"
import { afterAll, expect, it, onTestFinished, vi } from "vitest"
import { pinnedOriginHttpClient } from "../../src/http.ts"
import { HTTPRequestFailed, HTTPResponseError } from "../../src/sdk.ts"

const MiB = 1024 * 1024
const servers: Server[] = []
afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))))

async function serve(handler: RequestListener): Promise<string> {
	const server = createServer(handler)
	servers.push(server)
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function json(res: Parameters<RequestListener>[1], status: number, body: unknown, headers: Record<string, string> = {}) {
	res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body))
}

it("refuses a redirect at once without reaching its target, and keeps the SDK's error classes", async () => {
	let reached = 0
	let moved = 0
	const elsewhere = await serve((_, res) => {
		reached++
		json(res, 200, { publicKey: "0xee" })
	})
	const pinned = await serve((req, res) => {
		if (req.url === "/public-key") return json(res, 200, { publicKey: "0x18" })
		if (req.url === "/moved") {
			moved++
			return json(res, 302, {}, { location: `${elsewhere}/public-key` })
		}
		json(res, 404, { error: "no such route" })
	})
	const client = pinnedOriginHttpClient()
	expect(await client.get(`${pinned}/public-key`)).toEqual({ publicKey: "0x18" })

	const refused = client.get(`${pinned}/moved`)
	await expect(refused).rejects.toBeInstanceOf(HTTPRequestFailed)
	await expect(refused).rejects.toThrow(/answered a redirect \(302\), which this client refuses/)
	// Asked once, never retried, and its target never reached.
	expect([moved, reached]).toEqual([1, 0])

	// The ASP provider's fallback on a missing feed checks `instanceof` against this class.
	const missing = client.get(`${pinned}/yield/deposits`)
	await expect(missing).rejects.toBeInstanceOf(HTTPResponseError)
	await expect(missing).rejects.toMatchObject({ status: 404 })
})

it("refuses an answer past 16 MiB once decoded after one request, sent plain or as a small gzip body", async () => {
	const bomb = gzipSync(Buffer.alloc(17 * MiB))
	expect(bomb.byteLength).toBeLessThan(64 * 1024)
	const hits = { plain: 0, gzip: 0 }
	const pinned = await serve((req, res) => {
		if (req.url === "/plain") {
			hits.plain++
			return res.writeHead(200, { "content-type": "application/json" }).end(Buffer.alloc(17 * MiB, 0x20))
		}
		hits.gzip++
		res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(bomb)
	})
	const client = pinnedOriginHttpClient()
	for (const path of ["plain", "gzip"] as const) {
		const refused = client.get(`${pinned}/${path}`)
		await expect(refused).rejects.toBeInstanceOf(HTTPRequestFailed)
		await expect(refused).rejects.toThrow(/answered more than 16777216 bytes, which this client refuses/)
	}
	expect(hits).toEqual({ plain: 1, gzip: 1 })
})

it("reads an answer under the cap as the SDK client does, in each mode it reads one", async () => {
	// A byte-order mark, characters past ASCII and several chunks: what a decoder can get wrong.
	const doc = `﻿${JSON.stringify({ name: "ñandú €", leaves: Array.from({ length: 20_000 }, (_, i) => String(i)) })}`
	const bytes = Buffer.from(Array.from({ length: MiB }, (_, i) => (i * 7919) % 256))
	const pinned = await serve((req, res) => {
		if (req.url === "/doc") return res.writeHead(200, { "content-type": "application/json" }).end(doc)
		if (req.url === "/doc.gz") return res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(doc))
		if (req.url === "/bytes") return res.writeHead(200).end(bytes)
		res.writeHead(404, { "content-type": "text/plain" }).end(`﻿no such route: ñ ${"x".repeat(100_000)}`)
	})
	const ours = pinnedOriginHttpClient()
	const sdk = new HTTPClient()
	for (const path of ["/doc", "/doc.gz"]) expect(await ours.get(`${pinned}${path}`)).toEqual(await sdk.get(`${pinned}${path}`))
	const mineBytes = await ours.getBinary(`${pinned}/bytes`)
	const theirBytes = await sdk.getBinary(`${pinned}/bytes`)
	expect(mineBytes).toBeInstanceOf(Uint8Array)
	// A deep `toEqual` over a mebibyte takes seconds.
	expect(Buffer.compare(mineBytes, theirBytes)).toBe(0)
	const [mine, theirs] = await Promise.all([ours, sdk].map((c) => c.get(`${pinned}/missing`).catch((e: unknown) => e)))
	expect(mine).toBeInstanceOf(HTTPResponseError)
	expect(mine).toMatchObject({ status: 404, body: (theirs as HTTPResponseError).body })
})

it("keeps a redirect refused when cancelling its body fails", async () => {
	let calls = 0
	vi.stubGlobal("fetch", async () => {
		calls++
		const body = new ReadableStream({
			cancel() {
				throw new Error("cancel failed")
			},
		})
		return new Response(body, { status: 302, headers: { location: "http://127.0.0.1:1/" } })
	})
	onTestFinished(() => {
		vi.unstubAllGlobals()
	})
	await expect(pinnedOriginHttpClient().get("http://127.0.0.1:9/moved")).rejects.toThrow(/answered a redirect \(302\)/)
	expect(calls).toBe(1)
})

it("rejects a body it cannot serialise instead of throwing", async () => {
	await expect(pinnedOriginHttpClient().post("http://127.0.0.1:9/", { amount: 1n })).rejects.toBeInstanceOf(TypeError)
})
