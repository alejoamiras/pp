import { PoolClientError } from "@pp/pool-client"
import { ContractFunctionRevertedError, type Hash, toHex, UserRejectedRequestError } from "viem"
import { describe, expect, it, vi } from "vitest"
import {
	aztecWallet,
	bridgeSpend,
	context,
	DEPLOYMENT,
	FakeChain,
	fakePool,
	foreignError,
	headRequest,
	memoryStore,
	NETWORK,
	OWNER,
	openSession,
	randomRecipient,
} from "../test/client-fakes"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { MAX_UNRESOLVED_ATTEMPTS } from "./attempts"
import { BridgeClientError } from "./errors"
import { Journal, type JournalRecord, type KeyValueStore } from "./journal"
import { Preflights } from "./preflight"
import { useSession } from "./session"
import { MAX_REPROOFS, submit } from "./submit"
import type { PreparedBridgeSpend } from "./types"

async function setup(o: { pool?: ReturnType<typeof fakePool>; failWrite?: (n: number) => boolean; now?: () => number } = {}) {
	const pool = o.pool ?? fakePool()
	const session = await openSession(pool)
	const chain = new FakeChain()
	const { store, values } = memoryStore(o.failWrite)
	const preflights = new Preflights(o.now)
	const ctx = context(chain, store, preflights)
	const recipient = await randomRecipient()
	const wallet = aztecWallet([recipient])
	preflights.record(DEPLOYMENT.id, recipient, wallet, NETWORK)
	const journal = new Journal(store, useSession(session, DEPLOYMENT.id).secrets.journal, DEPLOYMENT.id)
	const spend = await bridgeSpend(recipient)
	return { pool, session, chain, store, values, preflights, ctx, recipient, wallet, journal, spend }
}

type Setup = Awaited<ReturnType<typeof setup>>

const code = async (p: Promise<unknown>) =>
	p.then(
		() => "resolved",
		(e: unknown) => (e instanceof BridgeClientError ? e.code : `not a BridgeClientError: ${String(e)}`),
	)

const hash = (n: number) => toHex(n, { size: 32 }) as Hash

function held(t: Setup, attempts: JournalRecord["attempts"], over: Partial<JournalRecord> = {}): Promise<string> {
	return t.journal.write({ nullifier: t.spend.nullifier, recipient: t.recipient.toString(), amount: t.spend.amount, attempts, ...over })
}

describe("submit: checks before anything is written or sent", () => {
	it.each<[string, (s: PreparedBridgeSpend, t: Setup) => Promise<PreparedBridgeSpend>]>([
		["salt", async (s, t) => bridgeSpend(t.recipient, { salt: s.claimSalt + 1n })],
		["secretHash", async (s) => ({ ...s, secretHash: toHex(1n, { size: 32 }) })],
		["data", async (s) => ({ ...s, data: `${s.data.slice(0, -2)}00` as typeof s.data })],
		["processor", async (s) => ({ ...s, processor: OWNER })],
		["asset", async (s) => ({ ...s, proof: { ...s.proof, pubSignals: s.proof.pubSignals.map((r, i) => (i === 6 ? [1n] : r)) } })],
	])("refuses a spend whose %s does not match, with zero sends and no record", async (check, mutate) => {
		const t = await setup()
		const e = await submit(t.ctx, await mutate(t.spend, t), t.chain.wallet(), t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "SPEND_MISMATCH", check })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
		expect(t.values.size).toBe(0)
	})

	it("passes pool-client's failed check through by name", async () => {
		const t = await setup()
		t.pool.assertRecoverable.mockRejectedValueOnce(new PoolClientError("SPEND_CHECK_FAILED", "x", { check: "change" }))
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).rejects.toMatchObject({ code: "SPEND_MISMATCH", check: "change" })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("refuses the owner as sender, compared by address, and needs a live preflight", async () => {
		const t = await setup()
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(OWNER.toLowerCase() as typeof OWNER), t.session))).toBe("SENDER_IS_OWNER")
		const other = await bridgeSpend(await randomRecipient())
		expect(await code(submit(t.ctx, other, t.chain.wallet(), t.session))).toBe("PREFLIGHT_REQUIRED")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("sends the snapshot with the captured account and chain, whatever the caller mutates during simulation", async () => {
		const t = await setup()
		const wallet = t.chain.wallet()
		const sentSignals = t.spend.proof.pubSignals[5] as bigint[]
		t.chain.simulate.mockImplementationOnce(async () => {
			sentSignals[0] = 1n
			;(t.spend.noteData as unknown as unknown[])[0] = { hint: toHex(2n, { size: 32 }), data: "0xff" }
			Object.assign(wallet, { account: { address: OWNER, type: "json-rpc" } })
			return {}
		})
		const receipt = await submit(t.ctx, t.spend, wallet, t.session)
		const sent = t.chain.writeContract.mock.calls[0]?.[0]
		expect(sent?.args[0].pubSignals[5]).toEqual([70n])
		expect(sent?.args[1]).toEqual([{ hint: toHex(1n, { size: 32 }), data: "0xab" }])
		expect(sent?.account.address).not.toBe(OWNER)
		expect(sent).toMatchObject({ chain: { id: 31337 }, gas: 125_000n })
		expect(receipt).toMatchObject({ amount: 70n, nullifier: t.spend.nullifier })
	})

	it("copies proof values by index into primitives, never through the caller's own methods", async () => {
		const t = await setup()
		const rows = t.spend.proof.pubSignals.map((r) => [...r])
		let reads = 0
		const shifting = Object.defineProperty([] as bigint[], 0, { get: () => (reads++ === 0 ? 70n : 1n), enumerable: true })
		const swapped = Array.prototype.map.call(rows, (r, i) => (i === 5 ? shifting : r))
		Object.defineProperty(rows, "map", { value: () => swapped })
		const tricky = { ...t.spend, proof: { ...t.spend.proof, pubSignals: rows } }
		await submit(t.ctx, tricky, t.chain.wallet(), t.session)
		expect(t.chain.writeContract.mock.calls[0]?.[0].args[0].pubSignals[5]).toEqual([70n])

		const u = await setup()
		const numeric = { ...u.spend, amount: 70 as unknown as bigint }
		expect(await code(submit(u.ctx, numeric, u.chain.wallet(), u.session))).toBe("SPEND_MISMATCH")
		expect(u.chain.writeContract).not.toHaveBeenCalled()
	})
})

describe("submit: preflight at handoff", () => {
	it("refuses with zero sends when the preflight expired while re-proving", async () => {
		let now = 0
		const t = await setup({ now: () => now })
		t.pool.assertFresh.mockRejectedValueOnce(new PoolClientError("ASP_ROOT_STALE", "x"))
		vi.mocked(t.ctx.reprove).mockImplementationOnce(async (_s, spend) => {
			now = 11 * 60_000
			return spend
		})
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("PREFLIGHT_REQUIRED")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
		expect(t.values.size).toBe(0)
	})

	it("lets one of two concurrent submits of a note reach the wallet, even through separate store adapters", async () => {
		const t = await setup()
		const other = await randomRecipient()
		t.preflights.record(DEPLOYMENT.id, other, aztecWallet([other]), NETWORK)
		const adapter: KeyValueStore = {
			getItem: (k) => t.store.getItem(k),
			setItem: (k, v) => t.store.setItem(k, v),
			removeItem: (k) => t.store.removeItem(k),
		}
		const second = context(t.chain, adapter, t.preflights)
		const held = Promise.withResolvers<object>()
		t.chain.simulate.mockReturnValueOnce(held.promise)
		const first = submit(t.ctx, t.spend, t.chain.wallet(), t.session)
		const rival = await code(submit(second, await bridgeSpend(other), t.chain.wallet(), t.session))
		held.resolve({})
		await first
		expect(rival).toBe("IN_FLIGHT")
		expect(t.chain.writeContract).toHaveBeenCalledTimes(1)
	})

	it("holds a note across generations and whatever vault a context names", async () => {
		const t = await setup()
		const otherGeneration = { ...DEPLOYMENT, portal: OWNER, poolVault: OWNER, id: "another generation" }
		const second = { ...context(t.chain, t.store, t.preflights), deployment: otherGeneration }
		const held = Promise.withResolvers<object>()
		t.chain.simulate.mockReturnValueOnce(held.promise)
		const first = submit(t.ctx, t.spend, t.chain.wallet(), t.session)
		const rival = await code(submit(second, t.spend, t.chain.wallet(), t.session))
		held.resolve({})
		await first
		expect(rival).toBe("IN_FLIGHT")
	})

	it("keeps a record another writer saved while the wallet call was out, when the user rejects", async () => {
		const t = await setup()
		t.chain.writeContract.mockImplementationOnce(async () => {
			for (const k of t.values.keys()) t.store.setItem(k, "theirs")
			throw new UserRejectedRequestError(new Error("no"))
		})
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("RPC_FAILED")
		expect([...t.values.values()]).toEqual(["theirs"])
	})

	it("takes a 4001 raised by another copy of viem as the user's rejection, and restores the record", async () => {
		const t = await setup()
		t.chain.writeContract.mockRejectedValueOnce(
			foreignError(["ContractFunctionExecutionError"], ["TransactionExecutionError"], ["UserRejectedRequestError", { code: 4001 }]),
		)
		const e = await submit(t.ctx, t.spend, t.chain.wallet(), t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "RPC_FAILED", source: "UserRejectedRequestError" })
		expect(t.values.size).toBe(0)
	})

	it("refuses a re-proof that is a valid spend of something else, with zero sends", async () => {
		const t = await setup()
		t.pool.assertFresh.mockRejectedValueOnce(new PoolClientError("ASP_ROOT_STALE", "x"))
		const smaller = await bridgeSpend(t.recipient, { amount: 60n })
		vi.mocked(t.ctx.reprove).mockResolvedValueOnce(smaller)
		const e = await submit(t.ctx, t.spend, t.chain.wallet(), t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "SPEND_MISMATCH", check: "request" })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("keys the hold only by a bigint proof nullifier equal to the spend's, refusing anything else with zero sends", async () => {
		const t = await setup()
		const rows = (first: unknown[]) => [first, ...t.spend.proof.pubSignals.slice(1)] as bigint[][]
		const cases: [PreparedBridgeSpend, string, string?][] = [
			[{ ...t.spend, proof: { ...t.spend.proof, pubSignals: rows([String(t.spend.nullifier)]) } }, "shape"],
			[{ ...t.spend, nullifier: String(t.spend.nullifier) as unknown as bigint }, "shape"],
			[{ ...t.spend, proof: { ...t.spend.proof, pubSignals: rows([]) } }, "nullifier"],
			[{ ...t.spend, nullifier: t.spend.nullifier + 1n }, "nullifier"],
		]
		for (const [spend, check] of cases)
			await expect(submit(t.ctx, spend, t.chain.wallet(), t.session)).rejects.toMatchObject({ code: "SPEND_MISMATCH", check })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
		expect(t.values.size).toBe(0)
	})

	it("refuses with zero sends when the preflighted wallet no longer lists the recipient", async () => {
		const t = await setup()
		t.preflights.record(DEPLOYMENT.id, t.recipient, aztecWallet([]), NETWORK)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("PREFLIGHT_REQUIRED")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("refuses with zero sends when the recipient leaves the wallet while the handoff reads its network", async () => {
		const t = await setup()
		const accounts = [t.recipient]
		const wallet = aztecWallet(accounts)
		const network = wallet.getChainInfo
		wallet.getChainInfo = async () => {
			accounts.length = 0
			return network()
		}
		t.preflights.record(DEPLOYMENT.id, t.recipient, wallet, NETWORK)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("PREFLIGHT_REQUIRED")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
		expect(t.values.size).toBe(0)
	})

	it("refuses with zero sends and nothing journaled when the preflighted wallet moved to another rollup", async () => {
		const t = await setup()
		t.wallet.version = 2n
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("CHAIN_MISMATCH")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
		expect(t.values.size).toBe(0)
	})
})

describe("submit: reading the outcome", () => {
	it("finds its own event on a node whose head lags the receipt, or past the older head viem shares", async () => {
		const t = await setup()
		Object.assign(t.chain.reader, { request: headRequest(() => t.chain.head - 1n) })
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).resolves.toMatchObject({ amount: 70n })

		const u = await setup()
		await u.chain.land(u.spend.secretHash, hash(1), u.spend.proof.pubSignals)
		await held(u, [{ l1TxHash: hash(1) }])
		const older = u.chain.head - 1n
		// viem's cache, or another caller's request still in flight, whatever `cacheTime` says.
		Object.assign(u.chain.reader, { getBlockNumber: async () => older })
		await expect(submit(u.ctx, u.spend, u.chain.wallet(), u.session)).resolves.toMatchObject({ l1TxHash: hash(1) })
		expect(u.chain.writeContract).not.toHaveBeenCalled()
	})

	it("finds a journaled send's event on reload when every head read lags its receipt, with zero wallet calls", async () => {
		const t = await setup()
		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		await held(t, [{ l1TxHash: hash(1) }])
		Object.assign(t.chain.reader, { request: headRequest(() => t.chain.head - 1n) })
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).resolves.toMatchObject({ l1TxHash: hash(1) })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
		expect(t.chain.simulate).not.toHaveBeenCalled()
	})

	it("is UNCERTAIN with a journaled mined send's hash when the logs cannot be read on reload", async () => {
		const t = await setup()
		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		await held(t, [{ l1TxHash: hash(1) }])
		Object.assign(t.chain.reader, { getLogs: async () => Promise.reject(new Error("rpc down")) })
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).rejects.toMatchObject({ code: "UNCERTAIN", l1TxHash: hash(1) })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("is UNCERTAIN with the hash, never RPC_FAILED, when the logs cannot be read after a mined send", async () => {
		const t = await setup()
		const land = t.chain.onSend
		t.chain.onSend = async (call, h) => {
			await land(call, h)
			Object.assign(t.chain.reader, { getLogs: async () => Promise.reject(new Error("rpc down")) })
		}
		const e = await submit(t.ctx, t.spend, t.chain.wallet(), t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "UNCERTAIN", l1TxHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
	})
})

describe("submit: earlier attempts (journal guard)", () => {
	it("is IN_FLIGHT while an attempt is pending and continues once every attempt reverted", async () => {
		const t = await setup()
		t.chain.pending.add(hash(1))
		await held(t, [{ l1TxHash: hash(1) }])
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("IN_FLIGHT")
		t.chain.revert(hash(1))
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet, NETWORK)
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).resolves.toMatchObject({ amount: 70n })
	})

	it("is UNCERTAIN for an unknown or hashless attempt until acceptUncertain, and a 4001 restores the record", async () => {
		const t = await setup()
		await held(t, [{ l1TxHash: hash(1) }, {}])
		const before = [...t.values.values()]
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).rejects.toMatchObject({ code: "UNCERTAIN", l1TxHash: hash(1) })
		t.chain.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error("no")))
		await submit(t.ctx, t.spend, t.chain.wallet(), t.session, { acceptUncertain: true }).catch(() => {})
		expect(t.chain.writeContract).toHaveBeenCalledTimes(1)
		expect([...t.values.values()]).toEqual(before)
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet, NETWORK)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("UNCERTAIN")
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet, NETWORK)
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session, { acceptUncertain: true })).resolves.toMatchObject({ amount: 70n })
		expect((await t.journal.read(t.spend.nullifier)).record?.attempts).toHaveLength(3)
	})

	it("keeps counting an earlier unknown attempt after a later one reverted, and refuses a new intent while one is open", async () => {
		const t = await setup()
		t.chain.revert(hash(2))
		await held(t, [{ l1TxHash: hash(1) }, { l1TxHash: hash(2) }])
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("UNCERTAIN")
		const elsewhere = await randomRecipient()
		t.preflights.record(DEPLOYMENT.id, elsewhere, aztecWallet([elsewhere]), NETWORK)
		const redirected = await bridgeSpend(elsewhere)
		expect(await code(submit(t.ctx, redirected, t.chain.wallet(), t.session, { acceptUncertain: true }))).toBe("UNCERTAIN")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("lets a fifth explicit retry through after four confirmed reverts", async () => {
		const t = await setup()
		for (const n of [1, 2, 3, 4]) t.chain.revert(hash(n))
		await held(
			t,
			[1, 2, 3, 4].map((n) => ({ l1TxHash: hash(n) })),
		)
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).resolves.toMatchObject({ amount: 70n })
		expect((await t.journal.read(t.spend.nullifier)).record?.attempts).toHaveLength(1)
	})

	it("evicts the oldest of four dropped attempts only on acceptUncertain, and stays UNCERTAIN after they all revert", async () => {
		const t = await setup()
		await held(
			t,
			[1, 2, 3, 4].map((n) => ({ l1TxHash: hash(n) })),
		)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("UNCERTAIN")
		t.chain.onSend = (_call, h) => t.chain.revert(h)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session, { acceptUncertain: true }))).toBe("REVERTED")
		const record = (await t.journal.read(t.spend.nullifier)).record
		expect(record).toMatchObject({ evicted: true })
		expect(record?.attempts).toHaveLength(MAX_UNRESOLVED_ATTEMPTS)
		expect(record?.attempts[0]?.l1TxHash).toBe(hash(2))
		for (const n of [2, 3, 4]) t.chain.revert(hash(n))
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet, NETWORK)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("UNCERTAIN")
	})
})

describe("submit: after the wallet call", () => {
	it("is UNCERTAIN with the hash when the hash cannot be saved or the receipt times out, never RPC_FAILED", async () => {
		const t = await setup({ failWrite: (n) => n === 2 })
		t.chain.onSend = () => {}
		const saveFailed = await submit(t.ctx, t.spend, t.chain.wallet(), t.session).catch((e: unknown) => e)
		expect(saveFailed).toMatchObject({ code: "UNCERTAIN", l1TxHash: expect.any(String) })

		const u = await setup()
		u.chain.onSend = () => {}
		const timedOut = await submit(u.ctx, u.spend, u.chain.wallet(), u.session).catch((e: unknown) => e)
		expect(timedOut).toMatchObject({ code: "UNCERTAIN", l1TxHash: expect.any(String) })
		expect((await u.journal.read(u.spend.nullifier)).record?.attempts[0]?.l1TxHash).toBe((timedOut as BridgeClientError).l1TxHash)
	})

	it("is UNCERTAIN with its own hash when the wallet replaced the send with a success that bridged nothing", async () => {
		const t = await setup()
		let sent: Hash | undefined
		t.chain.onSend = (_call, h) => {
			sent = h
			t.chain.head += 1n
			t.chain.receipts.set(h, { status: "success", blockNumber: t.chain.head, transactionHash: hash(999) })
		}
		const e = await submit(t.ctx, t.spend, t.chain.wallet(), t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "UNCERTAIN", l1TxHash: sent })
	})

	it("returns the event's receipt when the transaction landed but its hash could not be saved", async () => {
		const t = await setup({ failWrite: (n) => n === 2 })
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).resolves.toMatchObject({ amount: 70n })
	})
})

describe("submit: simulation reverts", () => {
	const revert = () => new ContractFunctionRevertedError({ abi: PROCESSOR_PORTAL_ABI, functionName: "bridgeFromPool" })

	it("returns a landed copy's receipt for any revert, and SIMULATION_REVERTED when nothing landed", async () => {
		const t = await setup()
		t.chain.simulate.mockRejectedValue(revert())
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("SIMULATION_REVERTED")
		await t.chain.land(t.spend.secretHash, hash(9), t.spend.proof.pubSignals)
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session)).resolves.toMatchObject({ l1TxHash: hash(9) })
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})

	it("reports a transport failure as RPC_FAILED without consulting the chain", async () => {
		const t = await setup()
		t.chain.simulate.mockRejectedValue(new Error("socket hang up"))
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("RPC_FAILED")
	})
})

describe("submit: stale proofs", () => {
	it.each(["STATE_ROOT_STALE", "KEYSTORE_ROOT_STALE", "ASP_ROOT_STALE"] as const)(
		"S6u re-proves exactly twice on %s, then reports STALE",
		async (stale) => {
			const t = await setup()
			t.pool.assertFresh.mockRejectedValue(new PoolClientError(stale, "x"))
			const onReprove = vi.fn()
			await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session, { onReprove })).rejects.toMatchObject({ code: "STALE", stale })
			expect(onReprove.mock.calls).toEqual(Array.from({ length: MAX_REPROOFS }, () => [stale]))
			expect(t.ctx.reprove).toHaveBeenCalledTimes(MAX_REPROOFS)
			expect(t.chain.writeContract).not.toHaveBeenCalled()
		},
	)

	it("S7u re-proves once on a stale state root, then bridges", async () => {
		const t = await setup()
		t.pool.assertFresh.mockRejectedValueOnce(new PoolClientError("STATE_ROOT_STALE", "x"))
		const onReprove = vi.fn()
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session, { onReprove })).resolves.toMatchObject({ amount: 70n })
		expect(onReprove.mock.calls).toEqual([["STATE_ROOT_STALE"]])
	})
})
