import { afterAll, describe, expect, it } from "bun:test"
import { HTTPRequestFailed, HTTPResponseError } from "#ppv2/core-sdk"
import { PinnedOriginHttpClient } from "../../src/client/http.ts"

describe("the pinned-origin HTTP client", () => {
	let reached = 0
	let moved = 0
	const elsewhere = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			reached++
			return Response.json({ publicKey: "0xee" })
		},
	})
	const pinned = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname
			if (path === "/public-key") return Response.json({ publicKey: "0x18" })
			if (path === "/moved") {
				moved++
				return Response.redirect(`http://127.0.0.1:${elsewhere.port}/public-key`, 302)
			}
			return new Response("no such route", { status: 404 })
		},
	})
	const base = `http://127.0.0.1:${pinned.port}`
	afterAll(() => {
		pinned.stop(true)
		elsewhere.stop(true)
	})

	it("refuses a redirect at once without reaching its target, and keeps the SDK's error classes", async () => {
		const client = new PinnedOriginHttpClient()
		expect(await client.get(`${base}/public-key`)).toEqual({ publicKey: "0x18" })
		const refused = client.get(`${base}/moved`)
		await expect(refused).rejects.toBeInstanceOf(HTTPRequestFailed)
		await expect(refused).rejects.toThrow(/answered a redirect \(302\), which this client refuses/)
		// Asked once, never retried, and its target never reached.
		expect([moved, reached]).toEqual([1, 0])
		const missing = client.get(`${base}/note-events`)
		await expect(missing).rejects.toBeInstanceOf(HTTPResponseError)
		await expect(missing).rejects.toMatchObject({ status: 404 })
	})
})
