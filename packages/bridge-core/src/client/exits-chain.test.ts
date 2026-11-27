import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { DomainSeparator } from "@aztec-labs/constants"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { EventSelector } from "@aztec-labs/stdlib/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { computeL2ToL1MessageHash, computeLogTag } from "@aztec-labs/stdlib/hash"
import { Tag } from "@aztec-labs/stdlib/logs"
import { computeL2ToL1MembershipWitnessFromMessagesInEpoch } from "@aztec-labs/stdlib/messaging"
import { TxHash, TxStatus } from "@aztec-labs/stdlib/tx"
import { OutboxAbi } from "@aztec-foundation/l1-artifacts/OutboxAbi"
import vectors from "@pp/bridge-spec/vectors/v1.json" with { type: "json" }
import {
	type Address,
	decodeFunctionData,
	encodeFunctionResult,
	getAddress,
	type Hash,
	type Hex,
	hexToBigInt,
	numberToHex,
	toHex,
	UserRejectedRequestError,
} from "viem"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { DEPLOYMENT, HUB, PORTAL, SENDER } from "../test/client-fakes"
import { l1Reader } from "./bridge-client"
import type { ClientDeployment } from "./deployment"
import { exitStatusOf, exitState } from "./exits"
import { assertExitPayee, type ExitContext, exitReads, exitTickets, ragequitPayload, settle } from "./exits-chain"
import { sponsoredFpcAddress } from "./payload"
import type { ExitTicket } from "./types"

const TOKEN = toHex(7n, { size: 32 })
const OTHER_TOKEN = toHex(8n, { size: 32 })
const D: ClientDeployment = { ...DEPLOYMENT, token: TOKEN, outbox: "0x00000000000000000000000000000000000000b4" }

// Exit contents come from the shared v1 vectors, never from this package's own encoder.
const RQ = vectors.ragequit[0]!
const OUT = vectors.out[0]!
const OUT_ELSEWHERE = vectors.out.find((v) => v.payee !== OUT.payee && BigInt(v.payee) > 1n)!

/** The signatures the hub's events carry on bridge-v1, written out so a layout change fails here. */
const SIGNATURES = { ragequit: "RagequitTicket((Field),(Field),u128,Field)", public: "PublicExitTicket((Field),(Field),u128)" }

const toPortal = (content: string) =>
	computeL2ToL1MessageHash({
		l2Sender: AztecAddress.fromStringUnsafe(HUB),
		l1Recipient: EthAddress.fromString(PORTAL),
		content: new Fr(BigInt(content)),
		rollupVersion: new Fr(D.rollupVersion),
		chainId: new Fr(D.chainId),
	})

/** One `ExitSettled`; `blockHash` defaults to the canonical header's at `block`. */
type Settled = {
	epoch: bigint
	leafId: bigint
	tx: Hash
	block: bigint
	blockHash?: Hash
	payee: Address
	amount: bigint
	label: bigint
}

/** The event the portal emits when it settles `t` at `w`. */
const settledFor = (t: ExitTicket, w: { epoch: bigint; leafId: bigint }, tx: Hash, block: bigint): Settled => ({
	epoch: w.epoch,
	leafId: w.leafId,
	tx,
	block,
	payee: t.payee,
	amount: t.amount,
	label: t.kind === "ragequit" ? t.label : 0n,
})

const TX_A = toHex(0xaan, { size: 32 })
const TX_B = toHex(0xbbn, { size: 32 })

/**
 * One epoch, one checkpoint, two blocks. Block 5's transaction A ragequits under the deployment's
 * token and another token; block 6's transaction B holds two identical public exits around a third
 * to another payee.
 */
async function world() {
	const messages = {
		[TX_A]: [toPortal(RQ.content), Fr.random()],
		[TX_B]: [toPortal(OUT.content), toPortal(OUT_ELSEWHERE.content), toPortal(OUT.content)],
	}
	const blocks = { [TX_A]: 5, [TX_B]: 6 }
	const epoch = [[messages[TX_A]], [messages[TX_B]]]
	const root = computeL2ToL1MembershipWitnessFromMessagesInEpoch([epoch], messages[TX_A][0]!, 0, 0, 0, 0).root
	const tag = async (kind: keyof typeof SIGNATURES) =>
		new Tag(await computeLogTag((await EventSelector.fromSignature(SIGNATURES[kind])).toField(), DomainSeparator.EVENT_LOG_TAG))
	const field = (v: string | bigint) => new Fr(BigInt(v))
	const log = async (kind: keyof typeof SIGNATURES, tx: Hex, token: Hex, v: { payee: string; amount: string; label?: string }) => ({
		tag: await tag(kind),
		logData: [field(0n), field(token), field(v.payee), field(v.amount), ...(v.label ? [field(v.label)] : [])],
		blockNumber: blocks[tx],
		blockHash: toHex(blocks[tx]!, { size: 32 }),
		txHash: TxHash.fromString(tx),
	})
	const logs = [
		await log("ragequit", TX_A, TOKEN, RQ),
		await log("ragequit", TX_A, OTHER_TOKEN, RQ),
		await log("public", TX_B, TOKEN, OUT),
		await log("public", TX_B, TOKEN, OUT_ELSEWHERE),
		await log("public", TX_B, TOKEN, OUT),
	]
	const state = {
		posted: false,
		head: 300n,
		cachedHead: undefined as bigint | undefined,
		/** How far the reader's backend trails the one that serves receipts, at each next latest-header read; then 0. */
		lags: [] as bigint[],
		/** The head each latest-header read answered. */
		latest: [] as bigint[],
		/** Bumping it replaces every header: a reorg. */
		fork: 0n,
		/** Reorg as an Outbox read is answered, between a decision's pin and its re-check. */
		reorgOnCall: false,
		/** The block each Outbox read named. */
		calls: [] as unknown[],
		consumed: new Set<string>(),
		settled: [] as Settled[],
	}
	const hashOf = (n: bigint) => toHex(n + (state.fork << 64n), { size: 32 })
	const node = {
		getPublicLogsByTags: vi.fn(async (q: { tags: Tag[]; fromBlock?: number }) => [
			logs.filter((l) => l.tag.equals(q.tags[0]!) && l.blockNumber >= (q.fromBlock ?? 0)),
		]),
		getTxReceipt: vi.fn(async (h: TxHash) => {
			const tx = h.toString() as Hex
			const msgs = messages[tx]
			if (!msgs) return { status: TxStatus.DROPPED, txHash: h }
			return {
				status: TxStatus.PROPOSED,
				txHash: h,
				epochNumber: 1,
				blockNumber: blocks[tx],
				txIndexInBlock: 0,
				txEffect: { l2ToL1Msgs: msgs },
			}
		}),
		getL2ToL1Messages: vi.fn(async () => [epoch]),
		getBlock: vi.fn(async (n: number) => ({ checkpointNumber: 1, indexWithinCheckpoint: n - 5 })),
		getCheckpointsData: vi.fn(async () => [{ checkpointNumber: 1 }]),
	}
	const zero = toHex(0n, { size: 32 })
	const header = ([tag]: readonly unknown[]) => {
		const n = tag === "latest" ? state.head - (state.lags.shift() ?? 0n) : hexToBigInt(tag as Hex)
		if (tag === "latest") state.latest.push(n)
		return n > state.head ? null : { number: numberToHex(n), hash: hashOf(n) }
	}
	const outbox = ([{ to, data }, block]: readonly unknown[] & [{ to: Address; data: Hex }, unknown]) => {
		state.calls.push(block)
		if (state.reorgOnCall) state.fork += 1n
		if (to !== D.outbox) throw new Error(`unexpected call to ${to}`)
		const { functionName, args } = decodeFunctionData({ abi: OutboxAbi, data })
		if (functionName === "getRoots") {
			const roots = Array.from({ length: 32 }, (_, i) => (i === 0 && state.posted ? root.toString() : zero)) as Hex[]
			return encodeFunctionResult({ abi: OutboxAbi, functionName, result: roots as never })
		}
		if (functionName !== "hasMessageBeenConsumedAtEpoch") throw new Error(`unexpected ${functionName}`)
		return encodeFunctionResult({ abi: OutboxAbi, functionName, result: state.consumed.has(`${args[0]}:${args[1]}`) })
	}
	const reader = {
		// viem's `getBlockNumber` can serve an older head at any `cacheTime` (its cache, or another
		// caller's request in flight); here the first head it saw never moves.
		getBlockNumber: async () => {
			state.cachedHead ??= state.head
			return state.cachedHead
		},
		request: vi.fn(async ({ method, params }: { method: string; params: readonly unknown[] }) => {
			if (method === "eth_getBlockByNumber") return header(params)
			if (method === "eth_call") return outbox(params as Parameters<typeof outbox>[0])
			throw new Error(`unexpected ${method}`)
		}),
		getLogs: vi.fn(async (q: { address: Address; args: { epoch: bigint }; fromBlock: bigint; toBlock: bigint }) =>
			state.settled
				.filter((s) => q.address === PORTAL && s.epoch === q.args.epoch && s.block >= q.fromBlock && s.block <= q.toBlock)
				.map((s) => ({
					args: { payee: s.payee, amount: s.amount, label: s.label, epoch: s.epoch, leafId: s.leafId },
					transactionHash: s.tx,
					blockNumber: s.block,
					blockHash: s.blockHash ?? hashOf(s.block),
					removed: false,
				})),
		),
		simulateContract: vi.fn(async (_call: unknown) => ({})),
		waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
			status: "success",
			transactionHash: hash,
			blockNumber: state.settled.find((s) => s.tx === hash)?.block,
		})),
	}
	// The portal settles a leaf once: consume at (epoch, 2^|path| + leafIndex), then ExitSettled.
	const writeContract = vi.fn(async (call: { functionName: string; args: readonly unknown[] }) => {
		const path = call.args.at(-1) as Hex[]
		const leafId = 2n ** BigInt(path.length) + (call.args.at(-2) as bigint)
		const epochOf = call.args.at(-4) as bigint
		const [payee, amount, label] = call.args as [Address, bigint, bigint]
		const tx = toHex(0xe0n + BigInt(state.settled.length), { size: 32 })
		state.head += 1n
		state.consumed.add(`${epochOf}:${leafId}`)
		const paid = { payee, amount, label: call.functionName === "settleRagequit" ? label : 0n }
		state.settled.push({ epoch: epochOf, leafId, tx, block: state.head, ...paid })
		return tx
	})
	const l1 = { account: { address: SENDER, type: "json-rpc" }, chain: undefined, getChainId: vi.fn(async () => 31337), writeContract }
	const c = { deployment: D, reader, node, timing: { receiptTimeoutMs: 1_000, pollingIntervalMs: 1 } } as unknown as ExitContext
	return { c, state, node, reader, l1: l1 as never, writeContract }
}

/** A vector's payee word as an address; a word of 2^160 or more becomes 21 bytes, which the encoder refuses as it refuses the word. */
const payeeOf = (word: string): Address => {
	const v = BigInt(word)
	return `0x${v.toString(16).padStart(v < 2n ** 160n ? 40 : 42, "0")}`
}

const status = async (c: ExitContext, t: ExitTicket) => exitStatusOf(await exitState(exitReads(c), t))

/** A loopback JSON-RPC endpoint that gives every request `answer(method)` and records each method. */
async function endpoint(answer: (method: string) => object) {
	const methods: string[] = []
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (chunk) => {
			body += chunk
		})
		req.on("end", () => {
			const { id, method } = JSON.parse(body) as { id: number; method: string }
			methods.push(method)
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method) }))
		})
	})
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
	onTestFinished(() => new Promise<void>((ok) => server.close(() => ok())))
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, methods }
}

const witnessOf = async (c: ExitContext, t: ExitTicket) => {
	const reads = exitReads(c)
	return reads.witness(t, await reads.pin())
}

describe("exit tickets", () => {
	it("decodes both ticket events as the hub emits them, keeps the deployment's token, and gives each identical exit its own message", async () => {
		const { c } = await world()
		const ragequit = { kind: "ragequit", token: TOKEN, payee: getAddress(RQ.payee), amount: BigInt(RQ.amount), label: BigInt(RQ.label) }
		const out = { kind: "public", token: TOKEN, payee: getAddress(OUT.payee), amount: BigInt(OUT.amount) }
		expect(await exitTickets(c, {})).toEqual([
			{ ...ragequit, l2TxHash: TX_A, messageIndexInTx: 0 },
			{ ...out, l2TxHash: TX_B, messageIndexInTx: 0 },
			{
				kind: "public",
				token: TOKEN,
				payee: getAddress(OUT_ELSEWHERE.payee),
				amount: BigInt(OUT_ELSEWHERE.amount),
				l2TxHash: TX_B,
				messageIndexInTx: 1,
			},
			{ ...out, l2TxHash: TX_B, messageIndexInTx: 2 },
		])
		expect(await exitTickets(c, { payee: getAddress(OUT.payee), fromBlock: 6n })).toEqual([
			{ ...out, l2TxHash: TX_B, messageIndexInTx: 0 },
			{ ...out, l2TxHash: TX_B, messageIndexInTx: 2 },
		])
	})

	it("reads proving until an Outbox root covers the ticket, then ready, and settled only for its exact (epoch, leafId)", async () => {
		const { c, state } = await world()
		const [ragequit] = await exitTickets(c, {})
		expect(await status(c, ragequit!)).toBe("proving")
		state.posted = true
		expect(await status(c, ragequit!)).toBe("ready")
		const w = await witnessOf(c, ragequit!)
		state.settled.push(settledFor(ragequit!, { ...w!, leafId: w!.leafId + 1n }, toHex(0xf1n, { size: 32 }), 250n))
		expect(await status(c, ragequit!)).toBe("ready")
		// The exact pair's event, but the pinned header's Outbox has not consumed the leaf: another branch's.
		state.settled.push(settledFor(ragequit!, w!, toHex(0xf2n, { size: 32 }), 250n))
		await expect(status(c, ragequit!)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
		state.consumed.add(`${w!.epoch}:${w!.leafId}`)
		expect(await status(c, ragequit!)).toBe("settled")
	})

	it("reads the Outbox at one pinned header's hash, scans no further than it, and refuses the decision once that header moved", async () => {
		const { c, state, reader } = await world()
		state.posted = true
		const [ragequit] = await exitTickets(c, {})
		expect(await status(c, ragequit!)).toBe("ready")
		expect(state.latest).toEqual([300n])
		expect(state.calls.length).toBeGreaterThan(1)
		expect(state.calls).toEqual(state.calls.map(() => ({ blockHash: toHex(300n, { size: 32 }) })))
		expect(reader.getLogs.mock.calls.map(([q]) => q.toBlock)).toEqual([300n])
		state.reorgOnCall = true
		await expect(status(c, ragequit!)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
	})

	it.each([
		["payee", { payee: SENDER }],
		["amount", { amount: BigInt(RQ.amount) + 1n }],
		["label", { label: 0n }],
		["block hash than the canonical header's", { blockHash: toHex(1n, { size: 32 }) }],
	])("refuses the exact pair's ExitSettled with another %s", async (_, change) => {
		const { c, state } = await world()
		state.posted = true
		const [ragequit] = await exitTickets(c, {})
		const w = await witnessOf(c, ragequit!)
		state.consumed.add(`${w!.epoch}:${w!.leafId}`)
		state.settled.push({ ...settledFor(ragequit!, w!, toHex(0xf2n, { size: 32 }), 250n), ...change })
		await expect(status(c, ragequit!)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
	})

	it("refuses a ticket whose message index names another message, and one whose transaction the node dropped", async () => {
		const { c } = await world()
		const [, out] = await exitTickets(c, {})
		await expect(status(c, { ...out!, messageIndexInTx: 1 })).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" })
		await expect(status(c, { ...out!, l2TxHash: toHex(0xccn, { size: 32 }) })).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" })
	})
})

describe("settle", () => {
	it.each([
		["a ragequit", 0, "settleRagequit", (t: ExitTicket) => [t.payee, t.amount, t.kind === "ragequit" && t.label]],
		["a public exit", 3, "settlePublicExit", (t: ExitTicket) => [t.payee, t.amount]],
	] as const)(
		"settles %s with its witness and returns the transaction of its ExitSettled, read past the older head viem shares",
		async (_, i, fn, head) => {
			const { c, state, reader, l1, writeContract } = await world()
			state.posted = true
			const t = (await exitTickets(c, {}))[i]!
			const w = await witnessOf(c, t)
			const tx = await settle(c, t, l1)
			const args = [...head(t), w!.epoch, w!.numCheckpointsInEpoch, w!.leafIndex, w!.path]
			expect(reader.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: PORTAL, functionName: fn, args }))
			expect(writeContract).toHaveBeenCalledOnce()
			expect(reader.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ timeout: c.timing.receiptTimeoutMs }))
			expect(tx).toBe(state.settled[0]?.tx)
			expect(await status(c, t)).toBe("settled")
			expect(await settle(c, t, l1)).toBe(tx)
			expect(writeContract).toHaveBeenCalledOnce()
		},
	)

	// A broadcast settle's only re-read is the floored one: no unfloored read follows its UNCERTAIN.
	it.each([
		[2, "returns its own transaction once the backend catches up"],
		[4, "keeps the hash as UNCERTAIN when the backend still lags after three retries, with no read after"],
	])("checks its settle at a header no lower than the receipt's block: lagging %i reads, it %s", async (lagging) => {
		const { c, state, l1, writeContract } = await world()
		state.posted = true
		const [t] = await exitTickets(c, {})
		const send = writeContract.getMockImplementation()!
		writeContract.mockImplementationOnce(async (call) => {
			const tx = await send(call)
			state.lags = Array.from({ length: lagging }, () => 1n)
			state.latest = []
			return tx
		})
		const result = await settle(c, t!, l1).catch((e: unknown) => e)
		const { tx, block } = state.settled[0]!
		const behind = Array.from({ length: lagging }, () => block - 1n)
		if (lagging < 4) {
			expect(result).toBe(tx)
			expect(state.latest).toEqual([...behind, block])
		} else {
			expect(result).toMatchObject({ code: "UNCERTAIN", l1TxHash: tx })
			expect(state.latest).toEqual(behind)
		}
	})

	it("keeps a broadcast settle's hash as UNCERTAIN when the event lookup after it fails", async () => {
		const { c, state, reader, l1, writeContract } = await world()
		state.posted = true
		const [t] = await exitTickets(c, {})
		const send = writeContract.getMockImplementation()!
		writeContract.mockImplementationOnce(async (call) => {
			const tx = await send(call)
			reader.getLogs.mockRejectedValue(new Error("connection refused"))
			return tx
		})
		const e = await settle(c, t!, l1).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "UNCERTAIN", l1TxHash: state.settled[0]?.tx })
	})

	it("reports the user's refusal of the settle as a refusal, also from a wallet client that throws at the call", async () => {
		const { c, state, l1, writeContract } = await world()
		state.posted = true
		const [t] = await exitTickets(c, {})
		const refused = { code: "RPC_FAILED", source: "UserRejectedRequestError" }
		writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error("no")))
		await expect(settle(c, t!, l1)).rejects.toMatchObject(refused)
		writeContract.mockImplementationOnce((() => {
			throw new UserRejectedRequestError(new Error("no"))
		}) as never)
		await expect(settle(c, t!, l1)).rejects.toMatchObject(refused)
	})

	it("keeps the hash as UNCERTAIN when the wallet replaced the send with a transaction that mined without settling", async () => {
		const { c, state, reader, l1, writeContract } = await world()
		state.posted = true
		const [t] = await exitTickets(c, {})
		const ours = toHex(0xd0n, { size: 32 })
		writeContract.mockImplementationOnce(async () => ours)
		reader.waitForTransactionReceipt.mockImplementationOnce(async () => {
			state.head += 1n
			return { status: "success", transactionHash: toHex(0xd1n, { size: 32 }), blockNumber: state.head }
		})
		await expect(settle(c, t!, l1)).rejects.toMatchObject({ code: "UNCERTAIN", l1TxHash: ours })
	})

	it.each([
		["a provider's lagging answer, retried by the transport alone", { error: { code: -32001, message: "block not found: 0x12c" } }, 4],
		["a null header, retried by the pin alone", { result: null }, 4],
		["another -32001", { error: { code: -32001, message: "block not found for an unrelated validation test" } }, 1],
	])("pins through the client's own reader with one retry owner per error: %s", async (_, answer, requests) => {
		const { url, methods } = await endpoint(() => answer)
		const timing = { receiptTimeoutMs: 1_000, pollingIntervalMs: 1 }
		const c = { deployment: D, reader: l1Reader(url, timing), node: {}, timing } as unknown as ExitContext
		await expect(exitReads(c).pin()).rejects.toBeDefined()
		expect(methods).toEqual(Array.from({ length: requests }, () => "eth_getBlockByNumber"))
	})

	it("refuses a wallet on another chain, and a ticket no root covers yet, before any send", async () => {
		const { c, l1, writeContract } = await world()
		const [ragequit] = await exitTickets(c, {})
		await expect(settle(c, ragequit!, l1)).rejects.toMatchObject({ code: "EXIT_NOT_READY" })
		;(l1 as { getChainId: () => Promise<number> }).getChainId = async () => 1
		await expect(settle(c, ragequit!, l1)).rejects.toMatchObject({ code: "CHAIN_MISMATCH" })
		expect(writeContract).not.toHaveBeenCalled()
	})
})

describe("ragequitPayload", () => {
	it("calls the hub's ragequit for the deployment's token, paid by the SponsoredFPC", async () => {
		const p = await ragequitPayload(D, { payee: getAddress(RQ.payee), amount: BigInt(RQ.amount), label: BigInt(RQ.label) })
		const call = p.calls.find((x) => x.name === "ragequit")
		expect(call?.to.toString()).toBe(HUB)
		expect(call?.args.map((a) => a.toBigInt())).toEqual([BigInt(TOKEN), BigInt(RQ.payee), BigInt(RQ.amount), BigInt(RQ.label)])
		expect(p.feePayer?.equals(await sponsoredFpcAddress())).toBe(true)
	})

	const refused = vectors.rejections
		.filter((r) => r.fn === "ragequitContent")
		.map(
			(r) =>
				[r.name, { payee: payeeOf(r.args.payee!), amount: BigInt(r.args.amount!), label: BigInt(r.args.label!) }, r.error] as const,
		)
	it.each([
		...refused,
		["the portal as payee", { payee: PORTAL, amount: 1n, label: 1n }, "PayeeIsPortal"] as const,
		[
			"a mixed-case payee whose checksum fails",
			{ payee: "0x000000000000000000000000000000000000BeeF", amount: 1n, label: 1n },
			"PayeeChecksum",
		] as const,
	])("refuses %s before building", async (_, a, source) => {
		await expect(ragequitPayload(D, a)).rejects.toMatchObject({ code: "SPEND_MISMATCH", source })
	})
})

describe("assertExitPayee", () => {
	it.each([
		["all lowercase", "0x000000000000000000000000000000000000beef"],
		["all uppercase", "0x000000000000000000000000000000000000BEEF"],
		["checksummed", "0x000000000000000000000000000000000000bEEF"],
	] as const)("accepts a payee %s, as the address parser that encodes it does", (_, payee) => {
		expect(() => assertExitPayee(PORTAL, payee)).not.toThrow()
	})
})
