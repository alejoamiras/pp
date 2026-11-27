import { describe, expect, test } from "vitest"
import { stackClock } from "./clock"

const NODE = "http://127.0.0.1:8080"
const l1 = { getBlock: async () => ({ timestamp: 1_700_000_100n }) } as unknown as Parameters<typeof stackClock>[0]
const answering = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body))) as typeof fetch
const block = (timestamp: unknown) => ({ jsonrpc: "2.0", id: 1, result: { header: { globalVariables: { timestamp } } } })

describe("the stack's chain clock", () => {
	test("reads each chain's latest block time; a node answer without one is an error, never a zero", async () => {
		await expect(stackClock(l1, NODE, answering(block("1700000000"))).aztecNow()).resolves.toBe(1_700_000_000n)
		await expect(stackClock(l1, NODE, answering(block("0x6553f100"))).aztecNow()).resolves.toBe(1_700_000_000n)
		await expect(stackClock(l1, NODE, answering(block(1.5))).aztecNow()).rejects.toThrow(/no latest block/)
		await expect(stackClock(l1, NODE, answering({ jsonrpc: "2.0", id: 1, result: null })).aztecNow()).rejects.toThrow(/no latest block/)
		await expect(stackClock(l1, NODE, answering(block("1"))).l1Now()).resolves.toBe(1_700_000_100n)
	})
})
