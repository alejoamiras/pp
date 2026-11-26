import { describe, expect, test } from "vitest"
import { ragequitChunks, singleCallAmounts } from "./chunks"

describe("ragequit chunks", () => {
	test("take only descending prefixes of at most 8 whole notes, never rounding", () => {
		expect(ragequitChunks([4n, 10n, 6n])).toEqual([20n])
		expect(ragequitChunks([4n, 10n, 6n], 16n)).toEqual([16n])
		expect(() => ragequitChunks([4n, 10n, 6n], 6n)).toThrow(expect.objectContaining({ code: "NO_EXACT_CHUNKS" }))
		expect(() => ragequitChunks([4n, 10n, 6n], 21n)).toThrow(expect.objectContaining({ code: "NO_EXACT_CHUNKS" }))
		const ten = Array.from({ length: 10 }, () => 1n)
		expect(ragequitChunks(ten)).toEqual([8n, 2n])
		expect(singleCallAmounts(ten)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])
	})
})
