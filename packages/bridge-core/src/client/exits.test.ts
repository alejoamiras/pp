import type { Hash, Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { allPages, type ExitReads, exitState, messageIndices, settleWith } from "./exits"
import type { ExitTicket } from "./types"

const T: ExitTicket = {
	kind: "ragequit",
	token: `0x${"01".repeat(32)}`,
	payee: "0x00000000000000000000000000000000000000e5",
	amount: 10n,
	label: 3n,
	l2TxHash: `0x${"02".repeat(32)}`,
	messageIndexInTx: 0,
}
const W = { epoch: 4n, leafId: 9n }
const TX = `0x${"aa".repeat(32)}` as Hash
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex

const reads = (o: Partial<{ witness: boolean; settled: (Hash | null)[]; consumed: boolean }>): ExitReads => {
	const settled = [...(o.settled ?? [null])]
	return {
		witness: async () => (o.witness === false ? undefined : W),
		settledTx: async () => (settled.length > 1 ? (settled.shift() ?? null) : (settled[0] ?? null)),
		consumed: async () => o.consumed ?? false,
	}
}

describe("exit tickets", () => {
	it("reads every page of a cursor-paged query", async () => {
		const pages = [{ items: [1, 2], next: "a" }, { items: [3], next: "b" }, { items: [4] }]
		const fetch = vi.fn(async (after: string | undefined) => pages[after === undefined ? 0 : after === "a" ? 1 : 2] ?? { items: [] })
		expect(await allPages(fetch)).toEqual([1, 2, 3, 4])
		expect(fetch.mock.calls.map((c) => c[0])).toEqual([undefined, "a", "b"])
	})

	it("gives identical tickets in one transaction successive occurrences", () => {
		expect(messageIndices([h(5), h(5)], [h(7), h(5), h(5)])).toEqual([1, 2])
		expect(() => messageIndices([h(5), h(5)], [h(5)])).toThrow(/RPC_INCONSISTENT/)
	})
})

describe("exitState (E1u: the controlled pre-root read)", () => {
	it("is proving without a witness, ready once one exists, settled only by the exact pair's event", async () => {
		expect(await exitState(reads({ witness: false }), T)).toEqual({ status: "proving" })
		expect(await exitState(reads({}), T)).toEqual({ status: "ready", witness: W })
		expect(await exitState(reads({ settled: [TX] }), T)).toEqual({ status: "settled", tx: TX })
	})

	it("re-reads once when the leaf is consumed but its event is missing, then reports the inconsistency", async () => {
		expect(await exitState(reads({ consumed: true, settled: [null, TX] }), T)).toEqual({ status: "settled", tx: TX })
		await expect(exitState(reads({ consumed: true }), T)).rejects.toThrow(/RPC_INCONSISTENT/)
	})
})

describe("settleWith", () => {
	it("refuses a proving ticket and returns an existing settlement without sending", async () => {
		const send = vi.fn(async () => TX)
		await expect(settleWith(reads({ witness: false }), T, send)).rejects.toThrow(/EXIT_NOT_READY/)
		expect(await settleWith(reads({ settled: [TX] }), T, send)).toBe(TX)
		expect(send).not.toHaveBeenCalled()
	})

	it("returns the other payer's transaction when a race reverts its own send", async () => {
		const other = `0x${"bb".repeat(32)}` as Hash
		const raced = reads({ settled: [null, other] })
		expect(
			await settleWith(raced, T, async () => {
				throw new Error("reverted")
			}),
		).toBe(other)
		await expect(
			settleWith(reads({}), T, async () => {
				throw new Error("reverted")
			}),
		).rejects.toThrow("reverted")
	})
})
