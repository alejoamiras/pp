import { afterAll, describe, expect, it } from "vitest"
import { startRecorder } from "./recorder"

describe("the recording front", () => {
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			new Response(`{"seen":"${new URL(req.url).search}"}`, { status: 201, headers: { "content-type": "application/json" } }),
	})
	const front = startRecorder({ port: 0, upstream: `http://127.0.0.1:${upstream.port}` })
	afterAll(async () => {
		await front.stop()
		await upstream.stop(true)
	})

	it("hands the upstream's answer back and records each request's method, path, query, headers and body size", async () => {
		const res = await fetch(`${front.url}/association-set/leaves?chainId=1&entrypoint=0xab`, { headers: { "user-agent": "probe/1" } })
		expect([res.status, await res.json()]).toEqual([201, { seen: "?chainId=1&entrypoint=0xab" }])
		await fetch(`${front.url}/x`, { method: "POST", body: "four" })
		expect(front.requests.map(({ headers, ...r }) => r)).toEqual([
			{ method: "GET", path: "/association-set/leaves", query: { chainId: "1", entrypoint: "0xab" }, bodyBytes: 0, status: 201 },
			{ method: "POST", path: "/x", query: {}, bodyBytes: 4, status: 201 },
		])
		expect(front.requests[0]?.headers["user-agent"]).toBe("probe/1")
		expect(front.requests[0]?.headers.host).toBeUndefined()
	})
})
