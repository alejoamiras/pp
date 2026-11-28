import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, expect, it } from "vitest"
import { pinnedOriginHttpClient } from "../../src/http.ts"
import { HTTPRequestFailed, HTTPResponseError } from "../../src/sdk.ts"

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
