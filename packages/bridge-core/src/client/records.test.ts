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
	return { session, chain, store, values, ctx, journal, recipient, spend, keep, setClaim: (c: ClaimState) => (claim = c) }
}

describe("records", () => {
	it("derives each step from the chain and drops a record once it reports it claimed", async () => {
		const t = await setup()
		t.chain.pending.add(hash(1))
		await t.keep([{ l1TxHash: hash(1) }])
		expect((await records(t.ctx, t.session))[0]).toMatchObject({ step: "submitted", l1TxHash: hash(1), nullifier: NULLIFIER })

		await t.chain.land(t.spend.secretHash, hash(1), t.spend.proof.pubSignals)
		expect((await records(t.ctx, t.session))[0]).toMatchObject({ step: "mined", receipt: { l1TxHash: hash(1), amount: 70n } })
		t.setClaim("found")
		expect((await records(t.ctx, t.session))[0]?.step).toBe("claimable")
		t.setClaim("nullified")
		expect((await records(t.ctx, t.session))[0]?.step).toBe("claimed")
		expect(await records(t.ctx, t.session)).toEqual([])
		expect(t.values.size).toBe(0)
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
