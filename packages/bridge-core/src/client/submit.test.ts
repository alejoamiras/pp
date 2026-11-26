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
	memoryStore,
	OWNER,
	openSession,
	randomRecipient,
} from "../test/client-fakes"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { MAX_UNRESOLVED_ATTEMPTS } from "./attempts"
import { BridgeClientError } from "./errors"
import { Journal, type JournalRecord } from "./journal"
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
	preflights.record(DEPLOYMENT.id, recipient, wallet)
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

function held(t: Setup, attempts: JournalRecord["attempts"], over: Partial<JournalRecord> = {}): Promise<void> {
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

	it("refuses with zero sends when the preflighted wallet no longer lists the recipient", async () => {
		const t = await setup()
		t.preflights.record(DEPLOYMENT.id, t.recipient, aztecWallet([]))
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("PREFLIGHT_REQUIRED")
		expect(t.chain.writeContract).not.toHaveBeenCalled()
	})
})

describe("submit: earlier attempts (journal guard)", () => {
	it("is IN_FLIGHT while an attempt is pending and continues once every attempt reverted", async () => {
		const t = await setup()
		t.chain.pending.add(hash(1))
		await held(t, [{ l1TxHash: hash(1) }])
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("IN_FLIGHT")
		t.chain.revert(hash(1))
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet)
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
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet)
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("UNCERTAIN")
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet)
		await expect(submit(t.ctx, t.spend, t.chain.wallet(), t.session, { acceptUncertain: true })).resolves.toMatchObject({ amount: 70n })
		expect((await t.journal.read(t.spend.nullifier)).record?.attempts).toHaveLength(3)
	})

	it("keeps counting an earlier unknown attempt after a later one reverted, and refuses a new intent while one is open", async () => {
		const t = await setup()
		t.chain.revert(hash(2))
		await held(t, [{ l1TxHash: hash(1) }, { l1TxHash: hash(2) }])
		expect(await code(submit(t.ctx, t.spend, t.chain.wallet(), t.session))).toBe("UNCERTAIN")
		const elsewhere = await randomRecipient()
		t.preflights.record(DEPLOYMENT.id, elsewhere, aztecWallet([elsewhere]))
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
		t.preflights.record(DEPLOYMENT.id, t.recipient, t.wallet)
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
