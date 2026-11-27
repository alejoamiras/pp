import { afterAll, describe, expect, it } from "bun:test"
import { createWalletClient, type Hex, http, keccak256 } from "viem"
import { type Handler, SENDER, STRANGER, type StubAnswer, signed, stub } from "./send-path.fixtures.ts"
import { SendPath, type SendPathError, type SendPathOptions, sendThrough } from "./send-path.ts"

const read = stub()
const send = stub()
afterAll(() => {
	read.stop()
	send.stop()
})
const path = (o: Partial<SendPathOptions> = {}) =>
	new SendPath({
		readUrl: read.url,
		sendUrl: send.url,
		chainId: 11155111,
		senders: [SENDER.address],
		budgetMs: 600,
		attemptTimeoutMs: 200,
		delayMs: 10,
		visibilityMs: 60_000,
		...o,
	})
const knownOn =
	(hashes: string[]): Handler =>
	(m, p) =>
		m === "eth_getTransactionByHash" && hashes.includes(String(p[0])) ? { result: { hash: p[0] } } : { result: null }
const failure = (e: unknown) => e as SendPathError

describe("a send", () => {
	it.each([
		["another chain", () => signed(1, 1)],
		["another sender", () => signed(1, 11155111, STRANGER)],
	])("from %s is refused before anything is forwarded", async (_, make) => {
		send.set(() => ({ result: "0x" }))
		const e = failure(
			await path()
				.send(await make())
				.catch((x) => x),
		)
		expect([e.kind, send.sends()]).toEqual(["envelope", []])
	})

	it("offers the same bytes again on refusals of every kind, and is admitted with the local hash", async () => {
		const raw = await signed(2)
		const answers: StubAnswer[] = [{ status: 429 }, { status: 503 }, { error: { code: -32005, message: "rate limit exceeded" } }]
		send.set((m) => (m === "eth_sendRawTransaction" ? (answers.shift() ?? { result: keccak256(raw) }) : { result: null }))
		expect(await path().send(raw)).toBe(keccak256(raw))
		expect(send.sends()).toEqual([raw, raw, raw, raw])
	})

	it("takes 'already known' after an answer lost to a timeout or an unreadable body as admitted", async () => {
		const raw = await signed(3)
		const answers: StubAnswer[] = [
			{ hangMs: 400, result: keccak256(raw) },
			{ body: "<html>" },
			{ error: { code: -32000, message: "already known" } },
		]
		send.set((m) => (m === "eth_sendRawTransaction" ? (answers.shift() as StubAnswer) : { result: null }))
		expect(await path().send(raw)).toBe(keccak256(raw))
		expect(send.sends()).toHaveLength(3)
	})

	it.each([
		["found on the read endpoint", true],
		["found nowhere", false],
	])("that the budget ends on is admitted only if %s", async (_, found) => {
		const raw = await signed(4)
		read.set(knownOn(found ? [keccak256(raw)] : []))
		send.set((m) => (m === "eth_sendRawTransaction" ? { status: 429 } : { result: null }))
		const out = await path().send(raw).catch(failure)
		if (found) expect(out).toBe(keccak256(raw))
		else
			expect([(out as SendPathError).kind, (out as SendPathError).tx?.nonce, (out as SendPathError).data]).toEqual([
				"budget",
				4,
				"HTTP 429",
			])
	})

	it.each([
		["nonce too low", true],
		["replacement transaction underpriced", false],
	])("answered '%s' is decided by the hash on both endpoints (known: %p)", async (message, found) => {
		const raw = await signed(5)
		read.set(() => ({ result: null }))
		send.set((m, p) =>
			m === "eth_sendRawTransaction" ? { error: { code: -32000, message } } : knownOn(found ? [keccak256(raw)] : [])(m, p),
		)
		const out = await path().send(raw).catch(failure)
		expect(found ? out : (out as SendPathError).kind).toBe(found ? keccak256(raw) : "conflict")
		expect(send.sends()).toHaveLength(1)
	})

	it.each([
		[
			"a final error, as the endpoint gave it",
			{ error: { code: -32003, message: "insufficient funds for gas * price + value" } },
			"final",
		],
		["another hash", { result: `0x${"cd".repeat(32)}` }, "other-hash"],
	])("answered with %s fails at once", async (_, a, kind) => {
		send.set((m) => (m === "eth_sendRawTransaction" ? a : { result: null }))
		const e = failure(
			await path()
				.send(await signed(6))
				.catch((x) => x),
		)
		expect([String(e.kind), send.sends().length]).toEqual([kind, 1])
		if (kind === "final") expect(e.upstream?.body).toContain("insufficient funds")
	})

	it("goes again as the same bytes when the read endpoint does not show it in time", async () => {
		const raw = await signed(7)
		send.set((m) => (m === "eth_sendRawTransaction" ? { result: keccak256(raw) } : { result: null }))
		read.set((m, p) => (m === "eth_getTransactionByHash" && send.sends().length >= 2 ? { result: { hash: p[0] } } : { result: null }))
		const p = path({ visibilityMs: 100, visibilityPollMs: 20 })
		const hash = await p.send(raw)
		expect(await p.visible(hash)).toBeGreaterThanOrEqual(100)
		expect(send.sends()).toEqual([raw, raw])
		p.close()
	})
})

describe("a viem wallet sending through the path", () => {
	it("hands its raw transaction to the path and its reads to its own transport", async () => {
		const raw = await signed(8)
		send.set((m) => (m === "eth_sendRawTransaction" ? { result: keccak256(raw) } : { result: null }))
		read.set((m) => (m === "eth_chainId" ? { result: "0xaa36a7" } : { result: null }))
		const p = path()
		const wallet = createWalletClient({ transport: sendThrough(http(read.url), p) })
		expect(await wallet.sendRawTransaction({ serializedTransaction: raw as Hex })).toBe(keccak256(raw))
		expect(await wallet.getChainId()).toBe(11155111)
		expect([send.sends(), read.calls.map((c) => c.method).filter((m) => m === "eth_chainId")]).toEqual([[raw], ["eth_chainId"]])
		p.close()
	})
})
