import { type Hash, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import {
	ASSET,
	bridgeSpend,
	DEPLOYMENT,
	FakeChain,
	fakePool,
	memoryStore,
	NULLIFIER,
	openSession,
	randomRecipient,
	SPENT_COMMITMENT,
} from "../test/client-fakes"
import type { ClaimState } from "./claim"
import { Journal } from "./journal"
import { records, recover } from "./records"
import { useSession } from "./session"

const hash = (n: number) => toHex(n, { size: 32 }) as Hash

async function setup() {
	const pool = {
		...fakePool(),
		notes: vi.fn(async () => [{ commitment: SPENT_COMMITMENT, label: 5n, value: 100n, asset: ASSET, status: "spent" as const }]),
	}
	const session = await openSession(pool)
	const chain = new FakeChain()
	const { store, values } = memoryStore()
	let claim: ClaimState = "missing"
	const node = {
		getL1ToL2MessageIndex: vi.fn(async () => 0n),
		getBlockData: vi.fn(async () => undefined),
		getL1ToL2MessageMembershipWitness: vi.fn(async () => (claim === "missing" ? undefined : ([0n, []] as never))),
		findLeavesIndexes: vi.fn(async () => [claim === "nullified" ? 1n : undefined] as never),
	}
	const ctx = { deployment: { ...DEPLOYMENT, hub: DEPLOYMENT.hub }, reader: chain.reader, node, store }
	const journal = new Journal(store, useSession(session, DEPLOYMENT.id).secrets.journal, DEPLOYMENT.id)
	const recipient = await randomRecipient()
	const spend = await bridgeSpend(recipient)
	const keep = (attempts: { l1TxHash?: Hash }[]) =>
		journal.write({ nullifier: NULLIFIER, recipient: recipient.toString(), amount: spend.amount, attempts })
	return { pool, session, chain, store, values, ctx, journal, recipient, spend, keep, setClaim: (c: ClaimState) => (claim = c) }
}

describe("records", () => {
	it("derives each step from the chain and drops a record once it reports it claimed", async () => {
		const t = await setup()
		t.chain.pending.add(hash(1))
		await t.keep([{ l1TxHash: hash(1) }])
		const [first] = await records(t.ctx, t.session)
		expect(first).toMatchObject({ step: "submitted", l1TxHash: hash(1), nullifier: NULLIFIER })
		expect(first?.recipient.equals(t.recipient)).toBe(true)

		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		expect((await records(t.ctx, t.session))[0]).toMatchObject({ step: "mined", receipt: { l1TxHash: hash(1), amount: 70n } })
		t.setClaim("found")
		expect((await records(t.ctx, t.session))[0]?.step).toBe("claimable")
		t.setClaim("nullified")
		expect((await records(t.ctx, t.session))[0]?.step).toBe("claimed")
		expect(await records(t.ctx, t.session)).toEqual([])
		expect(t.values.size).toBe(0)
	})

	it("deletes a claimed record only after every read passed, so a failed call never drops it unreported", async () => {
		const t = await setup()
		await t.keep([{ l1TxHash: hash(1) }])
		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		t.setClaim("nullified")
		const [claimed] = await t.pool.notes()
		t.pool.notes.mockResolvedValue([claimed!, { ...claimed!, commitment: 77n }])
		let failed = false
		t.pool.nullifierOf.mockImplementation((async (c: bigint) => {
			if (c !== 77n) return NULLIFIER
			if (failed) return 78n
			failed = true
			throw new Error("socket hang up")
		}) as never)
		await expect(records(t.ctx, t.session)).rejects.toBeDefined()
		expect((await records(t.ctx, t.session)).map((v) => v.step)).toEqual(["claimed"])
		expect(await records(t.ctx, t.session)).toEqual([])
	})

	it("reports a claimed record whose delete fails, and reports it again until the delete succeeds", async () => {
		const t = await setup()
		await t.keep([{ l1TxHash: hash(1) }])
		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		t.setClaim("nullified")
		const remove = t.store.removeItem
		t.store.removeItem = () => {
			throw new DOMException("denied", "SecurityError")
		}
		expect((await records(t.ctx, t.session)).map((v) => v.step)).toEqual(["claimed"])
		t.store.removeItem = remove
		expect((await records(t.ctx, t.session)).map((v) => v.step)).toEqual(["claimed"])
		expect(await records(t.ctx, t.session)).toEqual([])
	})

	it("skips and keeps a record that no longer opens", async () => {
		const t = await setup()
		await t.keep([{ l1TxHash: hash(1) }])
		const [key] = [...t.values.keys()]
		t.store.setItem(key!, "tampered")
		expect(await records(t.ctx, t.session)).toEqual([])
		expect(t.values.get(key!)).toBe("tampered")
	})
})

describe("recover", () => {
	it("finds the recipient's unclaimed bridge with records()'s id, and nothing for another recipient or once claimed", async () => {
		const t = await setup()
		await t.keep([{ l1TxHash: hash(1) }])
		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		const [view] = await records(t.ctx, t.session)
		const [found] = await recover(t.ctx, t.session, t.recipient)
		expect(found).toMatchObject({ id: view?.id, l1TxHash: hash(1), nullifier: NULLIFIER, amount: 70n })
		expect(await recover(t.ctx, t.session, await randomRecipient())).toEqual([])
		t.setClaim("nullified")
		expect(await recover(t.ctx, t.session, t.recipient)).toEqual([])
	})
})
