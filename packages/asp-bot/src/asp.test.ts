import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { BN254_P } from "@pp/bridge-spec"
import { MAX_LEAVES } from "@pp/label-paths"
import { afterEach, describe, expect, it, vi } from "vitest"
import pkg from "../package.json" with { type: "json" }
import { DEFAULT_USER_AGENT, fetchLeaves, fetchScopedLeaves, fetchScopedRoot, MAX_BODY_BYTES } from "./asp"

const SCOPE = { chainId: 11155111, entrypoint: "0x3191ed61bc961667f368600caf147f08cffa2559" } as const
const servers: { close(): void; closeAllConnections(): void }[] = []

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

const encoded = (body: Buffer, encoding: string) => (_: IncomingMessage, res: ServerResponse) =>
	res.writeHead(200, { "content-encoding": encoding, "content-length": String(body.length) }).end(body)

const failure = async (p: Promise<unknown>) =>
	(
		(await p.then(
			() => new Error("resolved"),
			(e: unknown) => e,
		)) as Error
	).message

afterEach(() => {
	vi.restoreAllMocks()
	for (const s of servers.splice(0)) {
		s.closeAllConnections()
		s.close()
	}
})

describe("the ASP API client", () => {
	it("names the bot in every request, scoped by chainId and entrypoint, and refuses a name without it", async () => {
		const asp = await api(json({ leaves: ["1", "22"], root: "333" }))
		expect(await fetchScopedLeaves(asp.url, SCOPE)).toEqual([1n, 22n])
		expect(await fetchScopedRoot(asp.url, SCOPE, { userAgent: "pp-aztec-bridge-bot/9 (a)" })).toBe(333n)
		const query = "chainId=11155111&entrypoint=0x3191ed61bc961667f368600caf147f08cffa2559"
		expect(asp.requests.map((r) => ({ path: r.url, ua: r.headers["user-agent"] }))).toEqual([
			{ path: `/association-set/leaves?${query}`, ua: DEFAULT_USER_AGENT },
			{ path: `/association-set/root?${query}`, ua: "pp-aztec-bridge-bot/9 (a)" },
		])
		expect(DEFAULT_USER_AGENT).toBe(`pp-aztec-bridge-bot/${pkg.version}`)
		for (const userAgent of ["", "pp-aztec-bridge-bot-extra", "curl/8"])
			expect(await failure(fetchLeaves(asp.url, { userAgent }))).toBe(
				"association-set/leaves: the User-Agent must start with pp-aztec-bridge-bot",
			)
		expect(asp.requests).toHaveLength(2)
	})

	it("sends one request per call: no redirect is followed, and a dropped connection is not retried", async () => {
		const elsewhere = await api(json({ leaves: [] }))
		const moved = await api((_, res) => res.writeHead(302, { location: `${elsewhere.url}/association-set/leaves` }).end())
		await expect(fetchScopedLeaves(moved.url, SCOPE)).rejects.toThrow()
		expect(elsewhere.requests).toHaveLength(0)
		let drop = false
		const flaky = await api((req, res) => (drop ? req.socket.destroy() : json({ leaves: ["1"] })(req, res)))
		await fetchLeaves(flaky.url)
		drop = true
		expect(await failure(fetchLeaves(flaky.url))).toBe("association-set/leaves: the request failed")
		expect(flaky.requests).toHaveLength(2)
	})

	it("refuses an answer over the cap, declared, streamed or inflated, and a body that stalls", async () => {
		const declared = await api((_, res) => res.writeHead(200, { "content-length": String(MAX_BODY_BYTES + 1) }).flushHeaders())
		await expect(fetchLeaves(declared.url)).rejects.toThrow(`exceeds ${MAX_BODY_BYTES} bytes`)
		const mib = "x".repeat(2 ** 20)
		const streamed = await api((_, res) => {
			res.writeHead(200)
			for (let sent = 0; sent <= MAX_BODY_BYTES; sent += mib.length) res.write(mib)
			res.end()
		})
		await expect(fetchLeaves(streamed.url)).rejects.toThrow(`exceeds ${MAX_BODY_BYTES} bytes`)
		const bomb = await api(encoded(gzipSync(Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)), "gzip"))
		await expect(fetchLeaves(bomb.url)).rejects.toThrow(`exceeds ${MAX_BODY_BYTES} bytes`)
		const stalled = await api((_, res) => res.writeHead(200).write('{"leaves":['))
		expect(await failure(fetchLeaves(stalled.url, { timeoutMs: 200 }))).toBe("association-set/leaves: timed out")
	})

	it("asks for an unencoded answer, inflates a gzip one, and refuses an encoding it cannot read", async () => {
		const gz = await api(encoded(gzipSync(JSON.stringify({ leaves: ["7"] })), "gzip"))
		expect(await fetchLeaves(gz.url)).toEqual([7n])
		expect(gz.requests[0]?.headers["accept-encoding"]).toBe("identity")
		const odd = await api(encoded(Buffer.from("{}"), "compress"))
		expect(await failure(fetchLeaves(odd.url))).toBe("association-set/leaves: unsupported content-encoding")
	})

	it("bounds the leaf count and the nesting before parsing, and the count again after", async () => {
		const parse = vi.spyOn(JSON, "parse")
		const commas = await api(
			json(
				`{"leaves":[${Array(MAX_LEAVES + 18)
					.fill('"1"')
					.join(",")}]}`,
			),
		)
		await expect(fetchLeaves(commas.url)).rejects.toThrow(`more than ${MAX_LEAVES} leaves`)
		const nested = await api(json(`{"leaves":${"[".repeat(100_000)}`))
		await expect(fetchLeaves(nested.url)).rejects.toThrow("not a flat list")
		expect(parse).not.toHaveBeenCalled()
		const one = await api(json({ leaves: Array(MAX_LEAVES + 1).fill("1") }))
		await expect(fetchLeaves(one.url)).rejects.toThrow(`more than ${MAX_LEAVES} leaves`)
	})

	it("never quotes the answer or the URL, and takes only field elements", async () => {
		const broken = await api(json('{"leaves": ["k3y"'))
		expect(await failure(fetchLeaves(broken.url))).toBe("association-set/leaves: the answer is not JSON")
		const p = await api(json({ leaves: ["1", String(BN254_P)] }))
		expect(await failure(fetchLeaves(p.url))).toBe("association-set/leaves: a leaf is outside [1, p)")
		expect(await failure(fetchLeaves("http://user:k3y@asp.invalid"))).toBe("association-set/leaves: the request failed")
		for (const [root, want] of [
			["0xabc", 0xabcn],
			[`0x${"f".repeat(64)}`, 2n ** 256n - 1n],
		] as const)
			expect(await fetchScopedRoot((await api(json({ root }))).url, SCOPE)).toBe(want)
		for (const root of [5, `0x${"f".repeat(65)}`, "1".repeat(79), "-1", null])
			await expect(fetchScopedRoot((await api(json({ root }))).url, SCOPE)).rejects.toThrow("not a decimal or 0x root")
	})
})
