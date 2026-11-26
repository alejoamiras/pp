import { describe, expect, test, vi } from "vitest"
import { assertNodeServesTarget } from "./node-check"
import { ConnectError } from "./types"

const TARGET = { nodeUrl: "http://127.0.0.1:8080", l1ChainId: 31337, rollupVersion: 7 }
const replying =
	(body: unknown, status = 200): typeof fetch =>
	async () =>
		new Response(JSON.stringify(body), { status })
const info = (l1ChainId: unknown, rollupVersion: unknown) => ({
	jsonrpc: "2.0",
	id: 1,
	result: { l1ChainId, rollupVersion, nodeVersion: "6.0.0" },
})
const check = (fetchFn: typeof fetch) => assertNodeServesTarget(TARGET, new AbortController().signal, fetchFn)
const codeOf = (p: Promise<unknown>) =>
	p.then(
		() => "passed",
		(e: unknown) => (e instanceof ConnectError ? e.code : `other: ${String(e)}`),
	)

describe("the node check", () => {
	test("passes a node on the target's chain, asked with plain node_getNodeInfo", async () => {
		const fetchFn = vi.fn(replying(info(31337, 7)))
		await check(fetchFn)
		const [url, init] = fetchFn.mock.calls[0] ?? []
		expect(url).toBe(TARGET.nodeUrl)
		expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "node_getNodeInfo", params: [] })
	})

	test("refuses a node on another L1 chain or rollup", async () => {
		expect(await codeOf(check(replying(info(1, 7))))).toBe("chain-mismatch")
		expect(await codeOf(check(replying(info(31337, 8))))).toBe("chain-mismatch")
	})

	test("reads no answer, an HTTP error or an unreadable answer as unreachable", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const down: typeof fetch = async () => {
			throw new TypeError("Failed to fetch")
		}
		expect(await codeOf(check(down))).toBe("node-unreachable")
		expect(await codeOf(check(replying(info(31337, 7), 500)))).toBe("node-unreachable")
		expect(await codeOf(check(replying(info("31337", 7))))).toBe("node-unreachable")
		expect(await codeOf(check(replying({ error: { code: -32601 } })))).toBe("node-unreachable")
	})
})
