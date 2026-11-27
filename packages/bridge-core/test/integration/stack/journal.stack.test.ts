import { keccak256 } from "viem"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bridgeClientOver, clientIo, createBridgeClient } from "../../../src/client/bridge-client"
import { Journal, type JournalRecord, openRecord, STORAGE_PREFIX } from "../../../src/client/journal"
import { prepareBridgeSpend } from "../../../src/client/prepare"
import { type BridgeSession, useSession } from "../../../src/client/session"
import { deploymentId } from "../../../src/client/types"
import { account, type Device, device, type Owner, owner, seedOf, sender, sessionOf } from "./support/actors"
import { attached, l1Client } from "./support/stack"
import { leaks, recordingStore } from "./support/store"
import { fillGap, recordingTransport } from "./support/transport"

const m = attached()
const seed = seedOf(m)
const chain = l1Client(m)
const DEPLOYMENT = deploymentId({ chainId: m.chainId, portal: m.bridge.portal, hub: m.bridge.hub })
const timings: Record<string, number> = {}
let dev: Device

beforeAll(async () => {
	dev = await device(m, "journal")
})

afterAll(async () => {
	await dev?.stop()
	console.log(`[journal] timings ms: ${JSON.stringify(timings)}`)
})

const code = (p: Promise<unknown>) =>
	p.then(
		() => "resolved",
		(e: { code?: string }) => e.code,
	)

const prepare = (s: BridgeSession, o: Owner, i: number, amount: bigint, recipient: Device["hub"]) =>
	prepareBridgeSpend(s, { note: o.notes[i]!.commitment, amount, portal: m.bridge.portal, recipient })

/** Every stored value, opened at its own key with the session's journal keys. */
async function opened(values: ReadonlyMap<string, string>, s: BridgeSession): Promise<(JournalRecord | null)[]> {
	const { secrets } = useSession(s, DEPLOYMENT)
	return Promise.all([...values].map(([k, v]) => openRecord(secrets.journal, k, v)))
}

/** A record holds exactly the fields the journal allows, and an attempt only its hash. */
function expectAllowed(records: (JournalRecord | null)[]): void {
	expect(records.length).toBeGreaterThan(0)
	for (const r of records) {
		expect(r).not.toBeNull()
		expect(Object.keys(r!).every((k) => ["nullifier", "recipient", "amount", "attempts", "evicted"].includes(k))).toBe(true)
		for (const a of r!.attempts) expect(Object.keys(a).every((k) => k === "l1TxHash")).toBe(true)
	}
}

describe("journal", () => {
	it("J1 a send held unmined behind a nonce gap survives a reload: submitted with its hash and IN_FLIGHT, then mined, claimed and gone", async () => {
		const t0 = performance.now()
		const o = await owner(m, seed, [100n])
		const { store, values } = recordingStore()
		const holder = await account(dev)
		const first = bridgeClientOver(m, clientIo(m, store), { receiptTimeoutMs: 3_000 })
		await first.preflight({ recipient: holder.address, wallet: dev.wallet })
		const s1 = await sessionOf(m, o)
		const spend = await prepare(s1, o, 0, 70n, holder.address)
		const wire = recordingTransport(m.l1Rpc)
		wire.hooks.nonceGap = true
		const l1 = await sender(m, wire.transport)
		const hash = await first.submit(spend, l1, s1).then(
			() => undefined,
			(e: { code?: string; l1TxHash?: `0x${string}` }) => (e.code === "UNCERTAIN" ? e.l1TxHash : undefined),
		)
		expect(hash).toBe(keccak256(wire.sends[0]!))
		expect((await chain.getTransaction({ hash: hash! })).blockNumber).toBeNull()

		const again = createBridgeClient({ manifest: m, journal: store })
		const s2 = await sessionOf(m, o)
		await again.preflight({ recipient: holder.address, wallet: dev.wallet })
		expect((await again.records(s2)).find((v) => v.nullifier === spend.nullifier)).toMatchObject({ step: "submitted", l1TxHash: hash })
		const quiet = recordingTransport(m.l1Rpc)
		expect(await code(again.submit(spend, await sender(m, quiet.transport), s2))).toBe("IN_FLIGHT")
		expect(quiet.sends).toEqual([])
		expectAllowed(await opened(values, s2))

		await fillGap(l1, m.l1Rpc)
		expect((await chain.waitForTransactionReceipt({ hash: hash! })).status).toBe("success")
		const mined = (await again.records(s2)).find((v) => v.nullifier === spend.nullifier)
		// A beat can make it claimable within seconds of mining.
		expect(mined).toMatchObject({ step: expect.stringMatching(/^(mined|claimable)$/), l1TxHash: hash })
		await again.waitClaimable(mined!.receipt!)
		await holder.deployWith(await again.claimPayload(s2, mined!.receipt!))
		expect((await again.records(s2)).find((v) => v.nullifier === spend.nullifier)?.step).toBe("claimed")
		expect(await again.records(s2)).toEqual([])
		expect(values.size).toBe(0)
		timings.J1 = Math.round(performance.now() - t0)
	})

	it("J2 the hash save fails while the send waits behind a nonce gap: a new client is UNCERTAIN with zero sends, then returns the winning receipt", async () => {
		const t0 = performance.now()
		const o = await owner(m, seed, [100n])
		const s = await sessionOf(m, o)
		const { store, control } = recordingStore()
		const holder = await account(dev)
		const first = createBridgeClient({ manifest: m, journal: store })
		await first.preflight({ recipient: holder.address, wallet: dev.wallet })
		const spend = await prepare(s, o, 0, 70n, holder.address)
		const wire = recordingTransport(m.l1Rpc)
		wire.hooks.nonceGap = true
		const l1 = await sender(m, wire.transport)
		// Write 1 appends the hashless attempt; write 2 would save its hash.
		control.failWrite = (n) => n === 2
		expect(await code(first.submit(spend, l1, s))).toBe("UNCERTAIN")
		control.failWrite = () => false
		const hash = keccak256(wire.sends[0]!)

		const second = createBridgeClient({ manifest: m, journal: store })
		await second.preflight({ recipient: holder.address, wallet: dev.wallet })
		const quiet = recordingTransport(m.l1Rpc)
		const l1b = await sender(m, quiet.transport)
		expect(await code(second.submit(spend, l1b, s))).toBe("UNCERTAIN")
		await fillGap(l1, m.l1Rpc)
		expect((await chain.waitForTransactionReceipt({ hash })).status).toBe("success")
		await expect(second.submit(spend, l1b, s)).resolves.toMatchObject({ l1TxHash: hash, amount: 70n })
		expect(quiet.sends).toEqual([])
		timings.J2 = Math.round(performance.now() - t0)
	})

	it("J3 the raw store holds no field value; each record opens to the allowed fields; a value moved to another record's key is skipped and kept", async () => {
		const t0 = performance.now()
		const o = await owner(m, seed, [987_654_321n, 987_654_321n])
		const s = await sessionOf(m, o)
		const { store, values, written } = recordingStore()
		const holder = await account(dev)
		const c = createBridgeClient({ manifest: m, journal: store })
		const l1 = await sender(m)
		const spends = [await prepare(s, o, 0, 123_456_789n, holder.address), await prepare(s, o, 1, 123_456_788n, holder.address)]
		const receipts = []
		for (const spend of spends) {
			await c.preflight({ recipient: holder.address, wallet: dev.wallet })
			receipts.push(await c.submit(spend, l1, s))
		}
		const [a, b] = spends as [(typeof spends)[0], (typeof spends)[0]]
		expect(
			leaks(written, {
				nullifierA: a.nullifier,
				nullifierB: b.nullifier,
				amountA: a.amount,
				amountB: b.amount,
				recipient: holder.address.toString(),
				l1TxHashA: receipts[0]!.l1TxHash,
				l1TxHashB: receipts[1]!.l1TxHash,
				secretHash: a.secretHash,
				spentCommitment: a.spentCommitment,
				label: o.notes[0]!.label,
			}),
		).toEqual([])
		expectAllowed(await opened(values, s))

		const journal = new Journal(store, useSession(s, DEPLOYMENT).secrets.journal, DEPLOYMENT)
		const [keyA, keyB] = [STORAGE_PREFIX + (await journal.id(a.nullifier)), STORAGE_PREFIX + (await journal.id(b.nullifier))]
		store.setItem(keyB, values.get(keyA)!)
		expect((await c.records(s)).map((v) => v.nullifier)).toEqual([a.nullifier])
		expect(values.get(keyB)).toBe(values.get(keyA))
		timings.J3 = Math.round(performance.now() - t0)
	})
})
