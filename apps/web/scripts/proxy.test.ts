import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { MAX_SNAPSHOT_BYTES } from "../src/data/adapters/snapshot-download"
import { bypassProxyForLoopback, CAPS, forward, isProxyPath, type ProxyConfig, proxyRoute, USER_AGENT } from "./proxy"

const EP = "0x1111111111111111111111111111111111111111"
const C: ProxyConfig = { chainId: 11155111, entrypoint: EP, asp: "http://127.0.0.1:1", bot: "http://127.0.0.1:2", operator: false }

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
		// The kind picks the operator's allowance for a route; the bot has none.
		expect(
			cases.map(([raw]) => {
				const r = proxyRoute(raw, C)
				return r?.upstream === "asp" ? r.kind : r?.upstream
			}),
		).toEqual(["bot", "bot", "root", "leaves", "public-key", "snapshot", "note-events", "note-events"])
		// The entrypoint compares without case and goes up spelled as configured, so every spelling is one upstream URL.
		const mixed = { ...C, entrypoint: `0x${"aB".repeat(20)}` }
		for (const spelling of [`0x${"ab".repeat(20)}`, `0x${"AB".repeat(20)}`, `0x${"Ab".repeat(20)}`])
			expect(proxyRoute(`/asp/association-set/root?chainId=11155111&entrypoint=${spelling}`, mixed)?.url).toBe(
				`http://127.0.0.1:1/association-set/root?chainId=11155111&entrypoint=0x${"aB".repeat(20)}`,
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
			"/asp/public-key?",
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
		const routes: Record<string, (res: ServerResponse) => void> = {
			"/redirect": (res) => res.writeHead(302, { location: "http://evil.example/" }).end(),
			"/big": (res) => res.writeHead(200).end(Buffer.alloc(2048)),
			"/slow": (res) => setTimeout(() => res.writeHead(200).end("{}"), 2_000),
			"/stall": (res) => res.writeHead(200).write("{"),
			"/gzip": (res) => res.writeHead(200, { "content-encoding": "gzip" }).end(Buffer.alloc(16)),
		}
		server = createServer((req, res) => {
			seen.push(req.headers)
			const path = req.url ?? "/"
			const status = Number(/^\/status\/(\d+)$/.exec(path)?.[1] ?? 0)
			if (status) return res.writeHead(status, { "content-type": "application/json", "set-cookie": "a=b" }).end('{"s":1}')
			;(routes[path] ?? ((r: ServerResponse) => r.writeHead(404).end()))(res)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	)

	test("passes the statuses the page acts on with their bodies, asking for JSON in no encoding as the app and nothing else", async () => {
		for (const status of [200, 400, 404, 501]) {
			const r = await forward(`${base}/status/${status}`)
			expect(r).toEqual({ ok: true, status, body: expect.any(Uint8Array) })
			if (r.ok) expect(Buffer.from(r.body).toString()).toBe('{"s":1}')
		}
		for (const h of seen) {
			expect(h.accept).toBe("application/json")
			expect(h["accept-encoding"]).toBe("identity")
			expect(h["user-agent"]).toBe(USER_AGENT)
			for (const name of ["cookie", "authorization", "origin", "referer", "x-forwarded-for"]) expect(h[name], name).toBeUndefined()
		}
	})

	test("fails every other status, a redirect, an encoded body, an overflow and a deadline, a stalled body included", async () => {
		expect(await forward(`${base}/status/500`)).toEqual({ ok: false, reason: "status 500" })
		expect(await forward(`${base}/status/401`)).toEqual({ ok: false, reason: "status 401" })
		expect(await forward(`${base}/redirect`)).toEqual({ ok: false, reason: "status 302" })
		expect(await forward(`${base}/gzip`)).toEqual({ ok: false, reason: "content-encoding gzip" })
		expect(await forward(`${base}/big`, { capBytes: 1024 })).toEqual({ ok: false, reason: "body over 1024 bytes" })
		expect(CAPS.bot).toBe(MAX_SNAPSHOT_BYTES)
		for (const path of ["/slow", "/stall"]) {
			const started = Date.now()
			expect(await forward(`${base}${path}`, { deadlineMs: 200 }), path).toEqual({ ok: false, reason: "timeout" })
			expect(Date.now() - started).toBeLessThan(1_500)
		}
		expect(await forward("http://127.0.0.1:1/")).toMatchObject({ ok: false, reason: expect.stringMatching(/^unreachable/) })
	})

	test("sends one request per call: a dropped connection is not retried", async () => {
		let drop = false
		let requests = 0
		const flaky = createServer((req, res) => {
			requests++
			if (drop) req.socket.destroy()
			else res.writeHead(200, { "content-type": "application/json" }).end("{}")
		})
		await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/`
		try {
			expect(await forward(url)).toMatchObject({ ok: true })
			drop = true
			expect(await forward(url)).toMatchObject({ ok: false })
			expect(requests).toBe(2)
		} finally {
			flaky.closeAllConnections()
			flaky.close()
		}
	})
})

describe("bypassProxyForLoopback", () => {
	test("adds 127.0.0.1 to both spellings of NO_PROXY, keeping what they named", () => {
		const env: NodeJS.ProcessEnv = { NO_PROXY: "example.com" }
		bypassProxyForLoopback(env)
		bypassProxyForLoopback(env)
		expect(env).toEqual({ NO_PROXY: "example.com,127.0.0.1", no_proxy: "127.0.0.1" })
	})
})
