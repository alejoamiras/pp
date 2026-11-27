import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { forward, isProxyPath, type ProxyConfig, proxyRoute } from "./proxy"

const EP = "0x1111111111111111111111111111111111111111"
const C: ProxyConfig = { chainId: 11155111, entrypoint: EP, asp: "http://127.0.0.1:1", bot: "http://127.0.0.1:2" }

describe("proxyRoute", () => {
	test("maps each frozen route to its upstream and rebuilds the query", () => {
		const cases: [string, string][] = [
			["/bot/v1/snapshots/latest", "http://127.0.0.1:2/v1/snapshots/latest"],
			["/bot/v1/snapshots/42?label=7", "http://127.0.0.1:2/v1/snapshots/42"],
			[
				`/asp/association-set/root?chainId=11155111&entrypoint=${EP}`,
				`http://127.0.0.1:1/association-set/root?chainId=11155111&entrypoint=${EP}`,
			],
			[
				`/asp/association-set/leaves?entrypoint=${EP}&chainId=11155111`,
				`http://127.0.0.1:1/association-set/leaves?chainId=11155111&entrypoint=${EP}`,
			],
			["/asp/public-key", "http://127.0.0.1:1/public-key"],
			[
				`/asp/11155111/public/event-snapshot/payload?entrypoint=${EP}`,
				`http://127.0.0.1:1/11155111/public/event-snapshot/payload?entrypoint=${EP}`,
			],
			[`/asp/11155111/public/note-events?entrypoint=${EP}`, `http://127.0.0.1:1/11155111/public/note-events?entrypoint=${EP}`],
			[
				`/asp/11155111/public/note-events?entrypoint=${EP}&since=10&until=20`,
				`http://127.0.0.1:1/11155111/public/note-events?entrypoint=${EP}&since=10&until=20`,
			],
		]
		for (const [raw, url] of cases) expect(proxyRoute(raw, C)?.url, raw).toBe(url)
		// The entrypoint compares without case; the value that goes up is the request's, once checked.
		const mixed = { ...C, entrypoint: `0x${"aB".repeat(20)}` }
		const lower = `0x${"ab".repeat(20)}`
		expect(proxyRoute(`/asp/association-set/root?chainId=11155111&entrypoint=${lower}`, mixed)?.url).toBe(
			`http://127.0.0.1:1/association-set/root?chainId=11155111&entrypoint=${lower}`,
		)
	})

	test("refuses every other target without decoding it", () => {
		const refused = [
			"http://evil.example/bot/v1/snapshots/latest",
			"//evil.example/bot/v1/snapshots/latest",
			"bot/v1/snapshots/latest",
			"/bot/v1/snapshots/0",
			"/bot/v1/snapshots/01",
			"/bot/v1/snapshots/123456789012345678901",
			"/bot/v1/snapshots/latest/",
			"/bot/v1/admin",
			"/bot/../asp/public-key",
			"/asp/admin/roots",
			"/asp/labels/5/status",
			"/asp/public-key?x=1",
			"/asp/public-key/",
			"/asp/%70ublic-key",
			"/asp/./public-key",
			"/asp/association-set/root",
			`/asp/association-set/root?chainId=1&entrypoint=${EP}`,
			`/asp/association-set/root?chainId=11155111&entrypoint=0x${"22".repeat(20)}`,
			`/asp/association-set/root?chainId=11155111&entrypoint=${EP}&extra=1`,
			`/asp/association-set/root?chainId=11155111&chainId=11155111&entrypoint=${EP}`,
			`/asp/association-set/root?chainId=11155111&entrypoint=${EP}&`,
			`/asp/association-set/root?chainId=11155111&entrypoint=${EP.slice(0, 41)}%31`,
			`/asp/1/public/event-snapshot/payload?entrypoint=${EP}`,
			`/asp/11155111/public/note-events?entrypoint=${EP}&since=-1`,
			`/asp/11155111/public/note-events?entrypoint=${EP}&since=1e3`,
			`/asp/11155111/public/note-events?entrypoint=${EP}&since=${"9".repeat(79)}`,
			`/asp/11155111/public/note-events?entrypoint=${EP}&since=1+2`,
			`/asp/11155111%2Fpublic/note-events?entrypoint=${EP}`,
			"/asp/11155111/public/yield-deposits",
		]
		for (const raw of refused) expect(proxyRoute(raw, C), raw).toBeNull()
	})

	test("claims its prefixes whether or not a route matches", () => {
		for (const raw of ["/asp", "/asp/", "/asp?x", "/bot/anything", "/asp/admin"]) expect(isProxyPath(raw), raw).toBe(true)
		for (const raw of ["/", "/aspx", "/assets/app.js", "/botany"]) expect(isProxyPath(raw), raw).toBe(false)
	})
})

describe("forward", () => {
	let server: Server
	let base = ""
	const seen: IncomingHttpHeaders[] = []
	beforeAll(async () => {
		server = createServer((req, res) => {
			seen.push(req.headers)
			const path = req.url ?? "/"
			const status = Number(/^\/status\/(\d+)$/.exec(path)?.[1] ?? 0)
			if (status) return res.writeHead(status, { "content-type": "application/json", "set-cookie": "a=b" }).end('{"s":1}')
			if (path === "/redirect") return res.writeHead(302, { location: "http://evil.example/" }).end()
			if (path === "/big") return res.writeHead(200).end(Buffer.alloc(2048))
			if (path === "/slow") return void setTimeout(() => res.writeHead(200).end("{}"), 2_000)
			res.writeHead(404).end()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

	test("passes the statuses the page acts on with their bodies, and sends no header of the client's", async () => {
		for (const status of [200, 400, 404, 501]) {
			const r = await forward(`${base}/status/${status}`)
			expect(r).toEqual({ ok: true, status, body: expect.any(Uint8Array) })
			if (r.ok) expect(Buffer.from(r.body).toString()).toBe('{"s":1}')
		}
		for (const h of seen) {
			expect(h.accept).toBe("application/json")
			for (const name of ["cookie", "authorization", "origin", "referer", "x-forwarded-for"]) expect(h[name], name).toBeUndefined()
		}
	})

	test("fails every other status, a redirect, an overflow and a deadline", async () => {
		expect(await forward(`${base}/status/500`)).toEqual({ ok: false, reason: "status 500" })
		expect(await forward(`${base}/status/401`)).toEqual({ ok: false, reason: "status 401" })
		expect(await forward(`${base}/redirect`)).toEqual({ ok: false, reason: "status 302" })
		expect(await forward(`${base}/big`, { capBytes: 1024 })).toEqual({ ok: false, reason: "body over 1024 bytes" })
		const started = Date.now()
		expect(await forward(`${base}/slow`, { deadlineMs: 200 })).toEqual({ ok: false, reason: "timeout" })
		expect(Date.now() - started).toBeLessThan(1_500)
		expect(await forward("http://127.0.0.1:1/")).toMatchObject({ ok: false, reason: expect.stringMatching(/^unreachable/) })
	})
})
