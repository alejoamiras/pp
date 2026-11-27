import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { MAX_LEAVES } from "@pp/label-paths"
import { afterEach, describe, expect, it, vi } from "vitest"
import pkg from "../package.json" with { type: "json" }
import { DEFAULT_USER_AGENT, fetchLeaves, fetchScopedLeaves, fetchScopedRoot, MAX_BODY_BYTES } from "./asp"

const SCOPE = { chainId: 11155111, entrypoint: "0x3191ed61bc961667f368600caf147f08cffa2559" } as const
const servers: { close(): void; closeAllConnections(): void }[] = []

/** A local ASP API whose every request is kept, answering with `handle`. */
async function api(handle: (req: IncomingMessage, res: ServerResponse) => void) {
	const requests: IncomingMessage[] = []
	const server = createServer((req, res) => {
		requests.push(req)
		handle(req, res)
	})
	servers.push(server)
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

const json = (body: unknown) => (_: IncomingMessage, res: ServerResponse) =>
	res.writeHead(200, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body))

afterEach(() => {
	vi.restoreAllMocks()
	for (const s of servers.splice(0)) {
		s.closeAllConnections()
		s.close()
	}
})

describe("the ASP API client", () => {
	it("names the bot in every request, scoped by chainId and entrypoint", async () => {
		const asp = await api(json({ leaves: ["1", "22"], root: "333" }))
		expect(await fetchScopedLeaves(asp.url, SCOPE)).toEqual([1n, 22n])
		expect(await fetchScopedRoot(asp.url, SCOPE, { userAgent: "pp-aztec-bridge-bot/9 (a)" })).toBe(333n)
		expect(requests(asp)).toEqual([
			{
				path: "/association-set/leaves?chainId=11155111&entrypoint=0x3191ed61bc961667f368600caf147f08cffa2559",
				ua: DEFAULT_USER_AGENT,
			},
			{
				path: "/association-set/root?chainId=11155111&entrypoint=0x3191ed61bc961667f368600caf147f08cffa2559",
				ua: "pp-aztec-bridge-bot/9 (a)",
			},
		])
		expect(DEFAULT_USER_AGENT).toBe(`pp-aztec-bridge-bot/${pkg.version}`)
	})

	it("fails on a redirect without following it", async () => {
		const elsewhere = await api(json({ leaves: [] }))
		const asp = await api((_, res) => res.writeHead(302, { location: `${elsewhere.url}/association-set/leaves` }).end())
		await expect(fetchScopedLeaves(asp.url, SCOPE)).rejects.toThrow()
		expect(elsewhere.requests).toHaveLength(0)
	})

	it("refuses an answer over the cap, declared or streamed, and a body that stalls", async () => {
		const declared = await api((_, res) => res.writeHead(200, { "content-length": String(MAX_BODY_BYTES + 1) }).flushHeaders())
		await expect(fetchLeaves(declared.url)).rejects.toThrow(`exceeds ${MAX_BODY_BYTES} bytes`)
		const mib = "x".repeat(2 ** 20)
		const streamed = await api((_, res) => {
			res.writeHead(200)
			for (let sent = 0; sent <= MAX_BODY_BYTES; sent += mib.length) res.write(mib)
			res.end()
		})
		await expect(fetchLeaves(streamed.url)).rejects.toThrow(`exceeds ${MAX_BODY_BYTES} bytes`)
		const stalled = await api((_, res) => res.writeHead(200).write('{"leaves":['))
		await expect(fetchLeaves(stalled.url, { timeoutMs: 200 })).rejects.toThrow()
	})

	it("bounds the leaf count before parsing, and again after", async () => {
		const parse = vi.spyOn(JSON, "parse")
		const commas = await api(
			json(
				`{"leaves":[${Array(MAX_LEAVES + 18)
					.fill('"1"')
					.join(",")}]}`,
			),
		)
		await expect(fetchLeaves(commas.url)).rejects.toThrow(`more than ${MAX_LEAVES} leaves`)
		expect(parse).not.toHaveBeenCalled()
		const one = await api(json({ leaves: Array(MAX_LEAVES + 1).fill("1") }))
		await expect(fetchLeaves(one.url)).rejects.toThrow(`more than ${MAX_LEAVES} leaves`)
	})

	it("never quotes a malformed answer, and takes only a field-sized root", async () => {
		const broken = await api(json('{"leaves": ["k3y"'))
		const err = (await fetchLeaves(broken.url).catch((e: unknown) => e)) as Error
		expect([err.message, err.message.includes("k3y")]).toEqual(["association-set/leaves: the answer is not JSON", false])
		for (const [root, want] of [
			["0xabc", 0xabcn],
			[`0x${"f".repeat(64)}`, 2n ** 256n - 1n],
		] as const)
			expect(await fetchScopedRoot((await api(json({ root }))).url, SCOPE)).toBe(want)
		for (const root of [5, `0x${"f".repeat(65)}`, "1".repeat(79), "-1", null])
			await expect(fetchScopedRoot((await api(json({ root }))).url, SCOPE)).rejects.toThrow("not a decimal or 0x root")
	})
})

function requests(a: { requests: IncomingMessage[] }) {
	return a.requests.map((r) => ({ path: r.url, ua: r.headers["user-agent"] }))
}
