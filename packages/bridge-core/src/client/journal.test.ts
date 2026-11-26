import { describe, expect, it } from "vitest"
import { MAX_UNRESOLVED_ATTEMPTS, pendingStep, planAttempt, type AttemptState } from "./attempts"
import {
	deriveJournalKeys,
	Journal,
	type JournalRecord,
	type KeyValueStore,
	openRecord,
	recordId,
	STORAGE_PREFIX,
	sealRecord,
} from "./journal"

const KEY = new Uint8Array(32).fill(7)
const DEPLOYMENT = "31337:0x00000000000000000000000000000000000000aa:0x00000000000000000000000000000000000000000000000000000000000000bb"
const NULLIFIER = 0x1234_5678_9abc_def0n
const RECIPIENT = `0x${"cd".repeat(32)}`
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const

const record = (over: Partial<JournalRecord> = {}): JournalRecord => ({
	nullifier: NULLIFIER,
	recipient: RECIPIENT,
	amount: 70n,
	attempts: [{ l1TxHash: H(1) }],
	...over,
})

const memoryStore = (): KeyValueStore & { map: Map<string, string> } => {
	const map = new Map<string, string>()
	return {
		map,
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	}
}

describe("journal sealing", () => {
	it("round-trips, uses a fresh nonce per write, and refuses a value moved to another key", async () => {
		const keys = await deriveJournalKeys(KEY)
		const key = STORAGE_PREFIX + (await recordId(keys, DEPLOYMENT, NULLIFIER))
		const a = await sealRecord(keys, key, record())
		const b = await sealRecord(keys, key, record())
		expect(a).not.toEqual(b)
		expect(await openRecord(keys, key, a)).toEqual(record())
		const other = STORAGE_PREFIX + (await recordId(keys, DEPLOYMENT, NULLIFIER + 1n))
		expect(await openRecord(keys, other, a)).toBeNull()
		expect(await openRecord(await deriveJournalKeys(new Uint8Array(32).fill(8)), key, a)).toBeNull()
	})

	it("keys records by HMAC output only and keeps nothing but the allowed fields", async () => {
		const keys = await deriveJournalKeys(KEY)
		const store = memoryStore()
		const journal = new Journal(store, keys, DEPLOYMENT)
		await journal.write(record({ evicted: true }))
		const [[storageKey, value]] = [...store.map]
		const id = storageKey?.slice(STORAGE_PREFIX.length) ?? ""
		expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
		for (const field of [NULLIFIER.toString(), NULLIFIER.toString(16), RECIPIENT.slice(2), "70", H(1).slice(2)]) {
			expect(storageKey).not.toContain(field)
			expect(value).not.toContain(field)
		}
		expect((await journal.read(NULLIFIER)).record).toEqual(record({ evicted: true }))
	})

	it("rejects a sealed plaintext with an extra field", async () => {
		const keys = await deriveJournalKeys(KEY)
		const key = `${STORAGE_PREFIX}x`
		const iv = crypto.getRandomValues(new Uint8Array(12))
		const extra = JSON.stringify({ v: 1, nullifier: "1", recipient: RECIPIENT, amount: "1", attempts: [], salt: "9" })
		const ct = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(key) },
			keys.seal,
			new TextEncoder().encode(extra),
		)
		const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
		const value = JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) })
		expect(await openRecord(keys, key, value)).toBeNull()
	})

	it("restores exactly what was there before a rejected attempt", async () => {
		const store = memoryStore()
		const journal = new Journal(store, await deriveJournalKeys(KEY), DEPLOYMENT)
		const before = await journal.read(NULLIFIER)
		await journal.write(record())
		await journal.restore(NULLIFIER, before.raw)
		expect(store.map.size).toBe(0)
		await journal.write(record())
		const held = await journal.read(NULLIFIER)
		await journal.write(record({ attempts: [{ l1TxHash: H(1) }, {}] }))
		await journal.restore(NULLIFIER, held.raw)
		expect((await journal.read(NULLIFIER)).raw).toBe(held.raw)
	})
})

describe("planAttempt", () => {
	const intent = { nullifier: NULLIFIER, recipient: RECIPIENT, amount: 70n }
	const plan = (r: JournalRecord | null, s: AttemptState[], accept = false, i = intent) => planAttempt(r, s, i, accept)

	it("sends a first attempt and refuses while any earlier one is pending", () => {
		expect(plan(null, [])).toEqual({ kind: "send", record: { ...intent, attempts: [{}] } })
		const r = record({ attempts: [{ l1TxHash: H(1) }, { l1TxHash: H(2) }] })
		expect(plan(r, ["reverted", "pending"], true)).toEqual({ kind: "refuse", code: "IN_FLIGHT", hashes: [H(2)] })
	})

	it("treats dropped and hashless attempts as uncertain until the caller accepts", () => {
		const r = record({ attempts: [{ l1TxHash: H(1) }, {}] })
		expect(plan(r, ["unknown", "hashless"])).toEqual({ kind: "refuse", code: "UNCERTAIN", hashes: [H(1)] })
		expect(plan(r, ["unknown", "hashless"], true)).toEqual({
			kind: "send",
			record: { ...record(), attempts: [{ l1TxHash: H(1) }, {}, {}] },
		})
		// A different intent never joins unresolved attempts, even with consent.
		expect(plan(r, ["unknown", "hashless"], true, { ...intent, amount: 71n }).kind).toBe("refuse")
	})

	it("lets the user retry after confirmed reverts, however many, with any intent", () => {
		const reverts = Array.from({ length: MAX_UNRESOLVED_ATTEMPTS }, (_, i) => ({ l1TxHash: H(i + 1) }))
		const other = { ...intent, recipient: `0x${"ef".repeat(32)}` }
		expect(plan(record({ attempts: reverts }), ["reverted", "reverted", "reverted", "reverted"], false, other)).toEqual({
			kind: "send",
			record: { ...other, attempts: [{}] },
		})
	})

	it("never locks a note: a full record with consent evicts its oldest attempt and stays uncertain for good", () => {
		const dropped = Array.from({ length: MAX_UNRESOLVED_ATTEMPTS }, (_, i) => ({ l1TxHash: H(i + 1) }))
		const full = record({ attempts: dropped })
		const unknown: AttemptState[] = ["unknown", "unknown", "unknown", "unknown"]
		expect(plan(full, unknown).kind).toBe("refuse")
		const next = plan(full, unknown, true)
		expect(next).toEqual({
			kind: "send",
			record: { ...record(), attempts: [{ l1TxHash: H(2) }, { l1TxHash: H(3) }, { l1TxHash: H(4) }, {}], evicted: true },
		})
		// Every kept attempt then reverts: the evicted hash may still land, so a plain call still refuses.
		if (next.kind !== "send") throw new Error("expected a send")
		const after = { ...next.record, attempts: next.record.attempts.map((_, i) => ({ l1TxHash: H(i + 10) })) }
		expect(plan(after, ["reverted", "reverted", "reverted", "reverted"])).toEqual({ kind: "refuse", code: "UNCERTAIN", hashes: [] })
		expect(pendingStep(after, ["reverted", "reverted", "reverted", "reverted"])).toBe("submitted")
	})

	it("derives the pending step from attempt states", () => {
		expect(pendingStep(record(), ["pending"])).toBe("submitted")
		expect(pendingStep(record(), ["reverted"])).toEqual({ error: "REVERTED" })
	})
})
