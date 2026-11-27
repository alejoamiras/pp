import { afterAll, describe, expect, it } from "bun:test"
import { createWalletClient, http } from "viem"
import { SEND_ATTEMPTS, sendRetrying } from "./send-retry.ts"

type Answer = { status?: number; error?: { code: number; message: string }; result?: string }
type Hex = `0x${string}`

/** A loopback JSON-RPC endpoint that answers each send from `script`, by attempt, and records its bytes. */
function gateway() {
	let script: (n: number) => Answer = () => ({ result: "0x" })
	const sent: unknown[] = []
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { id: number; method: string; params: unknown[] }
			if (body.method !== "eth_sendRawTransaction") return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" })
			sent.push(body.params[0])
			const a = script(sent.length)
			return Response.json({ jsonrpc: "2.0", id: body.id, ...a }, { status: a.status ?? 200 })
		},
	})
	const wallet = createWalletClient({ transport: sendRetrying(http(`http://127.0.0.1:${server.port}`), 0) })
	return {
		server,
		sent,
		/** viem's own action, which asks the transport for no retries of its own. */
		action: (raw: Hex) => wallet.sendRawTransaction({ serializedTransaction: raw }),
		/** A bare request, which would inherit the http transport's default retries. */
		bare: (raw: Hex) => wallet.request({ method: "eth_sendRawTransaction", params: [raw] }),
		answer(s: (n: number) => Answer) {
			script = s
			sent.length = 0
		},
	}
}

const RAW = "0x02f86e83aa36a7800212"
const HASH = `0x${"ab".repeat(32)}`
const limited = (n: number): Answer => ({ error: { code: -32005, message: `rate limit exceeded #${n}` } })

describe("sendRetrying", () => {
	const g = gateway()
	afterAll(() => g.server.stop(true))

	it.each(["action", "bare"] as const)("offers the identical bytes again while rate-limited, through a %s send", async (path) => {
		g.answer((n) => (n <= 2 ? limited(n) : { result: HASH }))
		expect(await g[path](RAW)).toBe(HASH)
		expect(g.sent).toEqual([RAW, RAW, RAW])
	})

	it.each(["action", "bare"] as const)(
		`stops after ${SEND_ATTEMPTS} attempts through a %s send, rejecting with the first refusal`,
		async (path) => {
			g.answer(limited)
			await expect(g[path](RAW)).rejects.toThrow(/rate limit exceeded #1\b/)
			expect(g.sent).toEqual(Array(SEND_ATTEMPTS).fill(RAW))
		},
	)

	it("resends the bytes it was handed, whatever the caller does to its request afterwards", async () => {
		g.answer((n) => (n === 1 ? limited(n) : { result: HASH }))
		const params: Hex[] = [RAW]
		const transport = sendRetrying(http(`http://127.0.0.1:${g.server.port}`), 5)({} as never)
		const pending = transport.request({ method: "eth_sendRawTransaction", params })
		params[0] = "0xdead"
		expect(await pending).toBe(HASH)
		expect(g.sent).toEqual([RAW, RAW])
	})

	it.each<[string, Answer]>([
		["another JSON-RPC error", { error: { code: -32003, message: "insufficient funds for gas * price + value" } }],
		["an HTTP 429", { status: 429 }],
	])("fails at once on %s", async (_, answer) => {
		g.answer(() => answer)
		await expect(g.action(RAW)).rejects.toThrow()
		expect(g.sent).toEqual([RAW])
	})
})
