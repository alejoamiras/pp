import { afterAll, describe, expect, it } from "bun:test"
import { createWalletClient, type Hex, http, keccak256, parseTransaction } from "viem"
import { type Handler, SENDER, STRANGER, type StubAnswer, signed, stub } from "./send-path.fixtures.ts"
import { checkEnvelope, classifySend, SendPath, type SendPathError, type SendPathOptions, sendThrough } from "./send-path.ts"

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

const HASH = `0x${"ab".repeat(32)}` as Hex
const rpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } })

describe("an endpoint's answer to a send", () => {
	// Real wording: geth's txpool errors, anvil 1.7.1's (observed), both pinned endpoints' (recorded), and
	// alloy-json-rpc 2.0.1's `is_retry_err` rules, the version forge 1.7.1 carries.
	it.each([
		["the local hash", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: HASH }), "admitted"],
		["geth: already known", 200, rpcError(-32000, "already known"), "known"],
		["anvil: transaction already imported", 200, rpcError(-32003, "transaction already imported"), "known"],
		["already known, in another case and padded", 200, rpcError(-32000, " Already Known "), "known"],
		["transaction is not already known", 200, rpcError(-32000, "transaction is not already known"), "final"],
		["unknown transaction", 200, rpcError(-32000, "unknown transaction"), "final"],
		["another hash", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"cd".repeat(32)}` }), "other-hash"],
		["a null result", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), "ambiguous"],
		["both endpoints: insufficient funds", 200, rpcError(-32003, "insufficient funds for gas * price + value"), "final"],
		["geth: nonce too low", 200, rpcError(-32000, "nonce too low"), "conflict"],
		["geth: replacement transaction underpriced", 200, rpcError(-32000, "replacement transaction underpriced"), "conflict"],
		["replacement underpriced", 200, rpcError(-32000, "replacement underpriced"), "conflict"],
		["geth: transaction underpriced", 200, rpcError(-32000, "transaction underpriced"), "final"],
		["geth: intrinsic gas too low", 200, rpcError(-32000, "intrinsic gas too low"), "final"],
		["geth: exceeds block gas limit", 200, rpcError(-32000, "exceeds block gas limit"), "final"],
		["geth: max fee per gas less than block base fee", 200, rpcError(-32000, "max fee per gas less than block base fee"), "final"],
		["geth: transaction type not supported", 200, rpcError(-32000, "transaction type not supported"), "final"],
		["Tenderly: HTTP 429", 429, "Too Many Requests", "refused"],
		["alloy: -32005 rate limited", 200, rpcError(-32005, "rate limited, try again in 4ms"), "refused"],
		["alloy: 429 Too Many Requests", 200, rpcError(429, "Too Many Requests"), "refused"],
		["alloy: -32000 too many requests", 200, rpcError(-32000, "too many requests"), "refused"],
		[
			"alloy: -32007 request limit",
			200,
			rpcError(-32007, "100/second request limit reached - reduce calls per second or upgrade your account at quicknode.com"),
			"refused",
		],
		["alloy: header not found", 200, rpcError(-32000, "header not found"), "refused"],
		["alloy: 1008 alone", 200, rpcError(1008, "too busy"), "refused"],
		["alloy: -32055 alone", 200, rpcError(-32055, "upstream error"), "refused"],
		["alloy: -32016 with rate limit", 200, rpcError(-32016, "over rate limit"), "refused"],
		["alloy: -32016 without it", 200, rpcError(-32016, "over quota"), "final"],
		["alloy: -32012 with credits", 200, rpcError(-32012, "credits limited to 6000/sec"), "refused"],
		["alloy: credits on another code", 200, rpcError(-32003, "insufficient funds: no account credits"), "final"],
		["alloy: daily request count", 200, rpcError(-32000, "daily request count exceeded, request rate limited"), "refused"],
		["alloy: message parts are case-sensitive", 200, rpcError(-32000, "Rate Limit exceeded"), "final"],
		["HTTP 502", 502, "Bad Gateway", "ambiguous"],
		["an unreadable body", 200, "<html>", "ambiguous"],
	])("%s", (_, status, text, kind) => {
		expect(String(classifySend(status as number, text as string, HASH).kind)).toBe(kind as string)
	})
})

describe("a send", () => {
	it.each([
		["legacy", "legacy", true],
		["eip2930", "eip2930", true],
		["eip4844", "eip4844", false],
		["eip7702", "eip7702", false],
	])("of type %s is checked against the type allow-list", async (_, type, passes) => {
		const base = { chainId: 11155111, nonce: 1, gas: 21_000n, to: STRANGER.address }
		const fees = { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }
		const raw = await SENDER.signTransaction(
			type === "legacy"
				? { ...base, type: "legacy", gasPrice: 2n }
				: type === "eip2930"
					? { ...base, type: "eip2930", gasPrice: 2n, accessList: [] }
					: type === "eip4844"
						? { ...base, ...fees, type: "eip4844", maxFeePerBlobGas: 2n, blobVersionedHashes: [`0x01${"00".repeat(31)}`] }
						: {
								...base,
								...fees,
								type: "eip7702",
								authorizationList: [
									await SENDER.signAuthorization({ chainId: 11155111, nonce: 2, address: STRANGER.address }),
								],
							},
		)
		const out = await checkEnvelope(raw, 11155111, [SENDER.address]).catch(failure)
		expect(passes ? (out as { hash: string }).hash : (out as SendPathError).kind).toBe(passes ? keccak256(raw) : "envelope")
	})

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
		read.set(() => ({ result: null }))
		send.set((m) => (m === "eth_sendRawTransaction" ? a : { result: null }))
		const e = failure(
			await path()
				.send(await signed(6))
				.catch((x) => x),
		)
		expect([String(e.kind), send.sends().length]).toEqual([kind, 1])
		if (kind === "final") expect(e.upstream?.body).toContain("insufficient funds")
	})

	it.each([
		["found", true],
		["not found", false],
	])("answered in wording no rule names is decided by a lookup of its hash (%s)", async (_, found) => {
		const raw = await signed(14)
		read.set(knownOn(found ? [keccak256(raw)] : []))
		send.set((m) => (m === "eth_sendRawTransaction" ? { error: { code: -32010, message: "AlreadyKnown" } } : { result: null }))
		const out = await path().send(raw).catch(failure)
		expect(found ? out : String((out as SendPathError).kind)).toBe(found ? keccak256(raw) : "final")
		expect(send.sends()).toHaveLength(1)
	})

	it("answers the same bytes sent again after a final answer with that answer, without forwarding them", async () => {
		const raw = await signed(15)
		read.set(() => ({ result: null }))
		send.set((m) => (m === "eth_sendRawTransaction" ? { error: { code: -32003, message: "insufficient funds" } } : { result: null }))
		const p = path()
		const first = failure(await p.send(raw).catch((x) => x))
		expect(failure(await p.send(raw).catch((x) => x))).toBe(first)
		expect([String(first.kind), send.sends()]).toEqual(["final", [raw]])
	})

	it("gets a last attempt just before its budget ends", async () => {
		const raw = await signed(10)
		const start = Date.now()
		send.set((m) =>
			m !== "eth_sendRawTransaction" ? { result: null } : Date.now() - start < 750 ? { status: 429 } : { result: keccak256(raw) },
		)
		expect(await path({ budgetMs: 1_000, delayMs: 20 }).send(raw)).toBe(keccak256(raw))
	})

	it.each([
		["an empty object", 200, {}],
		["another hash", 200, { hash: `0x${"cd".repeat(32)}` }],
		["its hash on HTTP 500", 500, "own"],
	])("is not found by a lookup answering %s", async (_, status, result) => {
		const raw = await signed(11)
		read.set(() => ({ result: null }))
		send.set((m) =>
			m === "eth_sendRawTransaction"
				? { error: { code: -32000, message: "nonce too low" } }
				: { status: status as number, result: result === "own" ? { hash: keccak256(raw) } : result },
		)
		expect(
			String(
				failure(
					await path()
						.send(raw)
						.catch((x) => x),
				).kind,
			),
		).toBe("conflict")
	})

	it("refuses a second transaction at a nonce it already sent, naming the one it waits on, and anything once closed", async () => {
		const raw = await signed(9)
		send.set((m, p) => (m === "eth_sendRawTransaction" ? { result: keccak256(p[0] as Hex) } : { result: null }))
		const p = path()
		await p.send(raw)
		const other = await SENDER.signTransaction({
			chainId: 11155111,
			type: "eip1559",
			nonce: 9,
			gas: 21_000n,
			maxFeePerGas: 3n,
			maxPriorityFeePerGas: 1n,
			to: STRANGER.address,
		})
		const e = failure(await p.send(other).catch((x) => x))
		expect([String(e.kind), e.message.includes(keccak256(raw)), send.sends()]).toEqual(["nonce", true, [raw]])
		p.close()
		expect(String(failure(await p.send(await signed(12)).catch((x) => x)).kind)).toBe("closed")
	})

	it("stops re-pushing once a re-push is answered with anything but an admission or a refusal", async () => {
		const raw = await signed(13)
		let n = 0
		send.set((m) =>
			m !== "eth_sendRawTransaction"
				? { result: null }
				: ++n === 1
					? { result: keccak256(raw) }
					: { error: { code: -32003, message: "insufficient funds for gas * price + value" } },
		)
		read.set(() => ({ result: null }))
		const p = path({ visibilityMs: 50, visibilityPollMs: 10 })
		expect(await p.visible(await p.send(raw))).toBeUndefined()
		expect(send.sends()).toHaveLength(2)
		p.close()
	})

	it("does not push again once closed while it was waiting on the read endpoint", async () => {
		const raw = await signed(16)
		send.set((m) => (m === "eth_sendRawTransaction" ? { result: keccak256(raw) } : { result: null }))
		read.set(() => ({ hangMs: 150, result: null }))
		const p = path({ visibilityMs: 1, visibilityPollMs: 10 })
		const hash = await p.send(raw)
		await Bun.sleep(50)
		p.close()
		expect(await p.visible(hash)).toBeUndefined()
		expect(send.sends()).toEqual([raw])
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
	it("hands its raw transaction to the path and its reads to its own transport, its head count never below its last send", async () => {
		const raw = await signed(8)
		send.set((m) => (m === "eth_sendRawTransaction" ? { result: keccak256(raw) } : { result: null }))
		read.set((m) => (m === "eth_chainId" ? { result: "0xaa36a7" } : { result: null }))
		const p = path()
		const wallet = createWalletClient({ transport: sendThrough(http(read.url), p) })
		expect(await wallet.sendRawTransaction({ serializedTransaction: raw as Hex })).toBe(keccak256(raw))
		expect(await wallet.getChainId()).toBe(11155111)
		expect([send.sends(), read.calls.map((c) => c.method).filter((m) => m === "eth_chainId")]).toEqual([[raw], ["eth_chainId"]])
		read.set((m) => (m === "eth_getTransactionCount" ? { result: "0x8" } : { result: null }))
		const count = (tag: string): Promise<unknown> =>
			wallet.request({ method: "eth_getTransactionCount", params: [SENDER.address, tag] } as never)
		expect([await count("pending"), await count("latest"), await count("0x10")]).toEqual(["0x9", "0x9", "0x8"])
		p.close()
	})

	it("signs its next transaction past its last send though the endpoint would fill in that send's nonce", async () => {
		send.set((m, p) => (m === "eth_sendRawTransaction" ? { result: keccak256(p[0] as Hex) } : { result: null }))
		const block = { number: "0x10", hash: `0x${"1".repeat(64)}`, timestamp: "0x1", baseFeePerGas: "0x1", transactions: [] }
		const filled = { nonce: "0x11", gas: "0x5208", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", type: "0x2", chainId: "0xaa36a7" }
		const reads: Record<string, unknown> = {
			eth_chainId: "0xaa36a7",
			eth_getTransactionCount: "0x11",
			eth_estimateGas: "0x5208",
			eth_maxPriorityFeePerGas: "0x1",
			eth_getBlockByNumber: block,
			eth_fillTransaction: { raw: "0x", tx: { ...filled, from: SENDER.address, to: STRANGER.address, value: "0x1", input: "0x" } },
		}
		read.set((m) => ({ result: reads[m] ?? null }))
		const p = path()
		await p.send(await signed(17))
		const chain = {
			id: 11155111,
			name: "sepolia",
			nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [read.url] } },
		}
		const wallet = createWalletClient({ account: SENDER, chain, transport: sendThrough(http(read.url), p) })
		await wallet.sendTransaction({ to: STRANGER.address, value: 1n })
		expect([
			send.sends().map((raw) => parseTransaction(raw as Hex).nonce),
			read.calls.some((c) => c.method === "eth_fillTransaction"),
		]).toEqual([[17, 18], false])
		p.close()
	})
})
