import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { keccak256 } from "viem"
import { SendPath } from "./send-path.ts"
import { SENDER, STRANGER, signed, stub } from "./send-path.fixtures.ts"
import { type SendRelay, startSendRelay } from "./send-relay.ts"

const read = stub()
const send = stub()
let dir: string
let prevRegistry: string | undefined
let relay: SendRelay

beforeAll(async () => {
	const parent = join(homedir(), ".cache/pp/pp-env")
	await mkdir(parent, { recursive: true })
	dir = await mkdtemp(join(parent, "send-relay-test-"))
	prevRegistry = process.env.PP_PORTS_REGISTRY
	process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
	relay = await startSendRelay({
		readUrl: read.url,
		sendUrl: send.url,
		chainId: 11155111,
		senders: [SENDER.address],
		owner: "send-relay-test",
		budgetMs: 400,
		attemptTimeoutMs: 200,
		delayMs: 10,
		freshMs: 300,
		readBudgetMs: 400,
	})
})
afterAll(async () => {
	await relay.stop()
	read.stop()
	send.stop()
	if (prevRegistry === undefined) delete process.env.PP_PORTS_REGISTRY
	else process.env.PP_PORTS_REGISTRY = prevRegistry
	await rm(dir, { recursive: true, force: true })
})

async function call(method: string, params: unknown[], url = relay.url) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
	})
	return (await res.json()) as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
}
const admitAll = () =>
	send.set((m, p) => (m === "eth_sendRawTransaction" ? { result: keccak256(p[0] as `0x${string}`) } : { result: null }))

describe("the send relay", () => {
	it("sends only eth_sendRawTransaction to the send endpoint, from a loopback port it registered", async () => {
		admitAll()
		read.set((m) => (m === "eth_chainId" ? { result: "0xaa36a7" } : { result: null }))
		const raw = await signed(1)
		expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
		expect(await readFile(join(dir, "ports.md"), "utf8")).toContain(`| ${new URL(relay.url).port} | send-relay | send-relay-test |`)
		expect((await call("eth_chainId", [])).result).toBe("0xaa36a7")
		expect(await call("eth_sendRawTransaction", [raw])).toMatchObject({ id: 7, result: keccak256(raw) })
		expect([read.calls.filter((c) => c.method !== "eth_getTransactionByHash").map((c) => c.method), send.sends()]).toEqual([
			["eth_chainId"],
			[raw],
		])
	})

	it("never answers a sender's head nonce below one past its last receipt the relay served, and asks a failed estimate again just after it", async () => {
		admitAll()
		const raw = await signed(5)
		const hash = await call("eth_sendRawTransaction", [raw])
		let estimates = 0
		let receipt: unknown = {}
		read.set((m) => {
			if (m === "eth_getTransactionReceipt") return { result: receipt }
			if (m === "eth_getTransactionCount") return { result: "0x3" }
			if (m === "eth_estimateGas")
				return ++estimates < 3 ? { error: { code: -32000, message: "execution reverted" } } : { result: "0x5208" }
			return { result: null }
		})
		// Neither an empty object, another transaction's receipt, nor one with no hex block number is this one's.
		for (receipt of [
			{},
			{ transactionHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1" },
			{ transactionHash: hash.result, blockNumber: "invalid" },
		])
			await call("eth_getTransactionReceipt", [hash.result])
		expect((await call("eth_getTransactionCount", [SENDER.address, "latest"])).result).toBe("0x3")
		receipt = { transactionHash: hash.result, blockNumber: "0x1", status: "0x1" }
		await call("eth_getTransactionReceipt", [hash.result])
		expect((await call("eth_getTransactionCount", [SENDER.address, "latest"])).result).toBe("0x6")
		expect((await call("eth_getTransactionCount", [SENDER.address, "0x2"])).result).toBe("0x3")
		expect((await call("eth_estimateGas", [{}])).result).toBe("0x5208")
		await Bun.sleep(350)
		estimates = 0
		expect((await call("eth_estimateGas", [{}])).error?.message).toBe("execution reverted")
	})

	it("answers a revert it asked again about as the revert, not as the refusal that followed it", async () => {
		admitAll()
		const hash = (await call("eth_sendRawTransaction", [await signed(7)])).result
		let estimates = 0
		read.set((m) => {
			if (m === "eth_getTransactionReceipt") return { result: { transactionHash: hash, blockNumber: "0x1" } }
			if (m === "eth_estimateGas") return ++estimates === 1 ? { error: { code: 3, message: "execution reverted" } } : { status: 503 }
			return { result: null }
		})
		await call("eth_getTransactionReceipt", [hash])
		expect([(await call("eth_estimateGas", [{}])).error?.message, estimates > 1]).toEqual(["execution reverted", true])
	})

	it("asks again a null receipt of a transaction it sent, and passes any other one at once", async () => {
		admitAll()
		const hash = (await call("eth_sendRawTransaction", [await signed(6)])).result
		let reads = 0
		read.set((m, p) =>
			m === "eth_getTransactionReceipt" && p[0] === hash && ++reads >= 3
				? { result: { transactionHash: hash, status: "0x1" } }
				: { result: null },
		)
		expect((await call("eth_getTransactionReceipt", [`0x${"11".repeat(32)}`])).result).toBeNull()
		expect([(await call("eth_getTransactionReceipt", [hash])).result, reads]).toEqual([{ transactionHash: hash, status: "0x1" }, 3])
	})

	it("asks again a read the endpoint refused, and gives up inside the read budget with an answer no client retry repeats", async () => {
		let n = 0
		read.set((m) => (m === "eth_blockNumber" ? (++n < 3 ? { status: 503 } : { result: "0x10" }) : { result: null }))
		expect((await call("eth_blockNumber", [])).result).toBe("0x10")
		read.set(() => ({ error: { code: -32005, message: "rate limit exceeded" } }))
		expect((await call("eth_blockNumber", [])).error).toMatchObject({ code: -32000, data: "-32005 rate limit exceeded" })
	})

	it("passes a final send answer through as the endpoint gave it", async () => {
		send.set(() => ({ error: { code: -32003, message: "insufficient funds for gas * price + value" } }))
		expect((await call("eth_sendRawTransaction", [await signed(9)])).error).toEqual({
			code: -32003,
			message: "insufficient funds for gas * price + value",
		})
	})

	it("drops its port row and stops listening when stopped", async () => {
		const other = await startSendRelay({
			readUrl: read.url,
			sendUrl: send.url,
			chainId: 11155111,
			senders: [],
			owner: "send-relay-test-2",
		})
		await other.stop()
		await other.stop()
		expect(await readFile(join(dir, "ports.md"), "utf8")).not.toContain("send-relay-test-2")
		await expect(fetch(other.url, { method: "POST", body: "{}" })).rejects.toThrow()
	})

	it("leaves a caller's path open when stopped, and its claims span the relay's sends and the caller's", async () => {
		admitAll()
		const path = new SendPath({ readUrl: read.url, sendUrl: send.url, chainId: 11155111, senders: [SENDER.address], delayMs: 10 })
		const shared = await startSendRelay({ path, owner: "send-relay-test-3" })
		expect((await call("eth_sendRawTransaction", [await signed(30)], shared.url)).result).toBe(keccak256(await signed(30)))
		await shared.stop()
		const other = await SENDER.signTransaction({
			chainId: 11155111,
			type: "eip1559",
			nonce: 30,
			gas: 21_000n,
			maxFeePerGas: 3n,
			maxPriorityFeePerGas: 1n,
			to: STRANGER.address,
		})
		await expect(path.send(other)).rejects.toThrow(/would reuse nonce 30/)
		expect(await path.send(await signed(31))).toBe(keccak256(await signed(31)))
		path.close()
	})
})
