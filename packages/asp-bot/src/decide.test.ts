import { describe, expect, it } from "vitest"
import { type DecideInput, decide, type SkipReason } from "./decide"

const record = { sequence: 4n, poolRoot: 11n, birthRoot: 0n, l1Block: 100n, rootTime: 5_000n, poolSize: 3n, birthSize: 0n }
const base: DecideInput = {
	record,
	aztecTime: 5_400n,
	e: { number: 120n, hash: "0x01", timestamp: 5_240n },
	poolRoot: 11n,
	birthRoot: 0n,
	poolSize: 3n,
	birthSize: 0n,
	lastReadTime: 5_100n,
	postNow: false,
	inclusionMarginSec: 144n,
}
const reasonOf = (i: Partial<DecideInput>) => {
	const d = decide({ ...base, ...i })
	return d.post ? "post" : d.reason
}

describe("decide", () => {
	it("posts a changed root as the next sequence at the selected block", () => {
		expect(decide({ ...base, poolRoot: 12n, poolSize: 4n, lastReadTime: base.aztecTime })).toEqual({
			post: true,
			args: { sequence: 5n, poolRoot: 12n, birthRoot: 0n, l1Block: 120n, rootTime: 5_240n, poolSize: 4n, birthSize: 0n },
		})
		expect(reasonOf({ birthRoot: 9n, birthSize: 1n, lastReadTime: base.aztecTime })).toBe("post")
	})

	it("heartbeats on chain time since the last landed read, and only on a newer Ethereum block", () => {
		expect(reasonOf({ lastReadTime: base.aztecTime - 300n })).toBe("post")
		expect(reasonOf({ lastReadTime: base.aztecTime - 299n })).toBe("unchanged")
		expect(reasonOf({ lastReadTime: null })).toBe("post")
		expect(reasonOf({ lastReadTime: null, e: { ...base.e, number: 100n, timestamp: 5_000n } })).toBe("unchanged")
	})

	it("mirrors every post_root assertion before sending", () => {
		const rows: [string, Partial<DecideInput>, SkipReason][] = [
			["zero pool root", { poolRoot: 0n }, "zero_pool_root"],
			["l1 block regressed", { poolRoot: 12n, e: { ...base.e, number: 99n } }, "record_ahead"],
			["root time regressed", { poolRoot: 12n, e: { ...base.e, timestamp: 4_999n } }, "root_time_regressed"],
			["new time on same block", { poolRoot: 12n, e: { ...base.e, number: 100n } }, "new_time_on_same_block"],
			["root time in the future", { e: { ...base.e, timestamp: 5_401n } }, "root_time_in_future"],
			["observation too old at inclusion", { aztecTime: 5_240n + 1_800n - 143n }, "lag"],
			["sequence at its limit", { record: { ...record, sequence: 2n ** 64n - 1n } }, "sequence_overflow"],
			["zero pool size", { poolSize: 0n }, "zero_pool_size"],
			["birth size without root", { birthSize: 1n }, "birth_size_disagrees"],
			["birth root without size", { birthRoot: 9n }, "birth_size_disagrees"],
			["pool list past 2^18", { poolSize: 2n ** 18n + 1n }, "size_too_large"],
			["birth list past 2^18", { birthRoot: 9n, birthSize: 2n ** 18n + 1n }, "size_too_large"],
		]
		for (const [name, input, reason] of rows) expect(reasonOf({ lastReadTime: null, ...input }), name).toBe(reason)
		expect(reasonOf({ lastReadTime: null, aztecTime: 5_240n + 1_800n - 144n })).toBe("post")
		expect(reasonOf({ poolRoot: 12n, e: { ...base.e, number: 100n, timestamp: 5_000n } })).toBe("post")
	})

	it("postNow posts a changed root or a newer Ethereum block, and otherwise says why not", () => {
		expect(reasonOf({ postNow: true, lastReadTime: base.aztecTime })).toBe("post")
		const sameBlock = { ...base.e, number: 100n, timestamp: 5_000n }
		expect(reasonOf({ postNow: true, e: sameBlock })).toBe("no_newer_block")
		expect(reasonOf({ postNow: true, e: sameBlock, poolRoot: 12n })).toBe("post")
	})
})
