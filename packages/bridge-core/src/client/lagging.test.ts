import { createPublicClient, custom } from "viem"
import { describe, expect, it, vi } from "vitest"
import { foreignError } from "../test/client-fakes"
import { BlockNotServedError, isLagging, isNotServed, LAGGING_RETRIES, laggingTolerant, retryLagging } from "./lagging"

// publicnode's Sepolia answers, verbatim, for a read past the head of the backend it picked.
const NOT_FOUND = { code: -32001, message: "block not found: 0xba826f" }
const HASH_NOT_FOUND = { code: -32001, message: `block not found: hash 0x${"ab".repeat(32)}` }
const BEYOND_HEAD = { code: -32602, message: "block range extends beyond current head block: requested 12223087, head 12223037" }

/** A viem client whose node fails each call with the next of `answers` while any are left, then answers "0x". */
function clientFailing(...answers: object[]) {
	const request = vi.fn(async () => {
		const a = answers.shift()
		if (a) throw a
		return "0x"
	})
	const client = createPublicClient({ transport: laggingTolerant(custom({ request }, { retryCount: 0 }), 1) })
	return { request, client }
}

const call = (c: ReturnType<typeof clientFailing>["client"]) =>
	c.request({ method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001" }, "latest"] })

describe("lagging-backend retries", () => {
	it("retries a lagging backend's exact answers three times, then rejects with the fourth failure as the read threw it", async () => {
		const ok = clientFailing(NOT_FOUND, BEYOND_HEAD, HASH_NOT_FOUND)
		expect(await call(ok.client)).toBe("0x")
		expect(ok.request).toHaveBeenCalledTimes(LAGGING_RETRIES + 1)

		const failing = clientFailing(NOT_FOUND, NOT_FOUND, NOT_FOUND, BEYOND_HEAD)
		await expect(call(failing.client)).rejects.toMatchObject({ code: BEYOND_HEAD.code, details: BEYOND_HEAD.message })
		expect(failing.request).toHaveBeenCalledTimes(LAGGING_RETRIES + 1)

		const thrown = [1, 2, 3, 4].map(() => new BlockNotServedError(7n))
		const read = vi.fn(async () => {
			throw thrown[read.mock.calls.length - 1]
		})
		await expect(retryLagging(1, read, isNotServed)).rejects.toBe(thrown[3])
		expect(read).toHaveBeenCalledTimes(LAGGING_RETRIES + 1)
	})

	it("keeps each error kind with one owner: the typed error is not a provider answer, nor the reverse", async () => {
		const typed = vi.fn(async () => {
			throw new BlockNotServedError(7n)
		})
		await expect(retryLagging(1, typed)).rejects.toBeInstanceOf(BlockNotServedError)
		const provider = vi.fn(async () => {
			throw NOT_FOUND
		})
		await expect(retryLagging(1, provider, isNotServed)).rejects.toBe(NOT_FOUND)
		expect([typed.mock.calls.length, provider.mock.calls.length]).toEqual([1, 1])
	})

	it.each([
		["another resource-not-found message", { code: -32001, message: "resource not found" }],
		["a message that only starts like a lagging one", { code: -32001, message: "block not found for an unrelated validation test" }],
		["a head message without its numbers", { code: -32602, message: "block range extends beyond current head block" }],
		["another invalid-params message", { code: -32602, message: "invalid argument 0: hex string has odd length" }],
		["a lagging message under another code", { code: -32000, message: "block not found: 0xba826f" }],
		["geth's own header error, not cited", { code: -32000, message: "header not found" }],
		["a lagging message with no code", new Error("block not found: 0xba826f")],
	])("does not retry %s", async (_, answer) => {
		const t = clientFailing(answer)
		await expect(call(t.client)).rejects.toBeDefined()
		expect(t.request).toHaveBeenCalledOnce()
	})

	it("never retries a send, even on a lagging answer", async () => {
		const t = clientFailing(NOT_FOUND)
		await expect(t.client.request({ method: "eth_sendRawTransaction", params: ["0x01"] })).rejects.toBeDefined()
		expect(t.request).toHaveBeenCalledOnce()
	})

	it("reads the answer by shape on another copy of viem's error chain", () => {
		const foreign = foreignError(
			["ContractFunctionExecutionError"],
			["ResourceNotFoundRpcError", { code: -32001, details: NOT_FOUND.message }],
		)
		expect(isLagging(foreign)).toBe(true)
		expect(isLagging(foreignError(["ResourceNotFoundRpcError", { code: -32001, details: "resource not found" }]))).toBe(false)
	})
})
