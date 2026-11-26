import { describe, expect, test } from "vitest"
import type { AztecAddress, BridgeRecordView, PoolNoteView } from "./a7"
import { reconcile } from "./reconcile"

const RECIPIENT = `0x${"1c".repeat(32)}` as AztecAddress
const note = (commitment: bigint): PoolNoteView => ({
	commitment,
	label: 1n,
	value: 10n,
	asset: "0x0000000000000000000000000000000000000001",
	status: "approved",
})
const record = (id: string, nullifier: bigint, extra: Partial<BridgeRecordView> = {}): BridgeRecordView => ({
	id,
	nullifier,
	recipient: RECIPIENT,
	amount: 5n,
	step: "submitted",
	...extra,
})

describe("reconciling bridge records", () => {
	test("a hashless record holds its unspent note, becomes a bridge once the chain shows it, and reads as spent elsewhere once its note is gone", () => {
		const records = [
			record("held", 1n),
			record("landed", 2n),
			record("gone", 3n),
			record("hashed", 4n, { l1TxHash: `0x${"01".repeat(32)}`, step: "mined" }),
			record("claimed", 5n, { step: "claimed" }),
			record("reverted", 6n, { step: { error: "REVERTED" } }),
		]
		const recovered = [record("landed", 2n, { l1TxHash: `0x${"02".repeat(32)}`, step: "mined" })]
		const unspent = new Map([
			[1n, note(11n)],
			[2n, note(12n)],
		])
		const r = reconcile(records, recovered, unspent)
		expect([...r.inFlight.keys()]).toEqual([11n])
		expect(r.bridges.map((b) => [b.id, b.step])).toEqual([
			["landed", "mined"],
			["hashed", "mined"],
		])
		expect(r.consumed.map((b) => b.id)).toEqual(["gone"])
	})
})
