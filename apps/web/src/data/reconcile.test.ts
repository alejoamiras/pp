import type { Hash } from "viem"
import { describe, expect, test } from "vitest"
import type { AztecAddress, BridgeRecordView, PoolNoteView } from "./a7"
import type { L1TxState } from "./ports"
import { reconcile } from "./reconcile"

const RECIPIENT = `0x${"1c".repeat(32)}` as AztecAddress
const note = (commitment: bigint): PoolNoteView => ({
	commitment,
	label: 1n,
	value: 10n,
	asset: "0x0000000000000000000000000000000000000001",
	status: "approved",
})
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash
const record = (id: string, nullifier: bigint, extra: Partial<BridgeRecordView> = {}): BridgeRecordView => ({
	id,
	nullifier,
	recipient: RECIPIENT,
	amount: 5n,
	step: "submitted",
	...extra,
})

describe("reconciling bridge records", () => {
	test("reads each open record against the chain, never against its stored hash alone", () => {
		const records = [
			record("hashless", 1n),
			record("lost", 2n, { l1TxHash: hash(2) }),
			record("pending", 3n, { l1TxHash: hash(3) }),
			record("mined", 4n, { l1TxHash: hash(4) }),
			record("landed", 5n),
			record("gone", 6n),
			record("claimed", 7n, { step: "claimed" }),
			record("reverted", 8n, { step: { error: "REVERTED" } }),
		]
		const recovered = [
			record("landed", 5n, { l1TxHash: hash(5), step: "mined" }),
			record("forgotten", 9n, { l1TxHash: hash(9), step: "mined" }),
		]
		const unspent = new Map([1n, 2n, 3n, 5n].map((n) => [n, note(10n + n)]))
		const txs = new Map<Hash, L1TxState>([
			[hash(2), "unknown"],
			[hash(3), "pending"],
			[hash(4), "mined"],
		])
		const r = reconcile(records, recovered, unspent, txs)
		expect([...r.uncertain.keys()]).toEqual([11n, 12n])
		expect([...r.inFlight].map(([n, x]) => [n, x.l1TxHash])).toEqual([[13n, hash(3)]])
		expect(r.bridges.map((b) => [b.id, b.step])).toEqual([
			["mined", "submitted"],
			["landed", "mined"],
			["forgotten", "mined"],
		])
		expect(r.consumed.map((b) => b.id)).toEqual(["gone"])
	})
})
