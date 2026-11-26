import { describe, expect, test, vi } from "vitest"
import type { PoolNoteView } from "./a7"
import { allowListAge, chainAge, poolNotesView } from "./model"

const note = (commitment: bigint, value: bigint, status: PoolNoteView["status"]): PoolNoteView => ({
	commitment,
	label: commitment,
	value,
	asset: "0x0000000000000000000000000000000000000001",
	status,
})

describe("view models", () => {
	test("ages come from the chain clock, never Date.now()", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0)
		const clock = { aztecNow: vi.fn(async () => 1_000_240n), l1Now: vi.fn(async () => 9n) }
		const record = { sequence: 128n, poolRoot: 1n, birthRoot: 0n, l1Block: 7n, rootTime: 1_000_000n }
		expect(await allowListAge(clock, record)).toEqual({ seconds: 240n, text: "4 min ago (chain time)" })
		expect(clock.aztecNow).toHaveBeenCalledOnce()
		expect(now).not.toHaveBeenCalled()
		expect([chainAge(10n, 9n).text, chainAge(0n, 59n).text, chainAge(0n, 7_200n).text]).toEqual([
			"just now (chain time)",
			"59 s ago (chain time)",
			"2 h ago (chain time)",
		])
	})

	test("pool notes: terminal ones hidden, zero-value ones counted, only approved ones bridge", () => {
		const view = poolNotesView([
			note(1n, 100n, "approved"),
			note(2n, 25n, "pending"),
			note(3n, 0n, "approved"),
			note(4n, 9n, "revoked"),
			note(5n, 9n, "exiting"),
			note(6n, 9n, "spent"),
			note(7n, 9n, "exited"),
			note(8n, 9n, "inactive"),
		])
		expect(view.emptyCount).toBe(1)
		expect(view.rows.map((r) => [r.note.commitment, r.text, r.blocked === undefined])).toEqual([
			[1n, "Approved", true],
			[2n, "Not approved yet", false],
			[4n, "Approval withdrawn", false],
			[5n, "Leaving the pool", false],
			[8n, "Unknown", false],
		])
	})
})
