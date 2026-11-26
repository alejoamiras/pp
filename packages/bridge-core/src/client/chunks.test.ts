import { describe, expect, it } from "vitest"
import { ragequitChunks } from "./chunks"
import { BridgeClientError } from "./errors"

const ones = (n: number, v = 1n) => Array.from({ length: n }, () => v)

describe("ragequitChunks", () => {
	it("splits the whole balance into chunks of at most 8 notes, largest first", () => {
		expect(ragequitChunks([])).toEqual([])
		expect(ragequitChunks(ones(8))).toEqual([8n])
		expect(ragequitChunks(ones(9))).toEqual([8n, 1n])
		expect(ragequitChunks([...ones(16, 2n), 5n])).toEqual([5n + 7n * 2n, 8n * 2n, 2n])
	})

	it("accepts an amount only when a descending prefix sums to it", () => {
		expect(ragequitChunks([4n, 10n, 6n], 16n)).toEqual([16n])
		expect(ragequitChunks(ones(10, 3n), 30n)).toEqual([24n, 6n])
		// The contract would take the 10 and make change of 4.
		expect(() => ragequitChunks([10n, 6n, 4n], 6n)).toThrow(BridgeClientError)
		expect(() => ragequitChunks([10n, 6n, 4n], 6n)).toThrow(/NO_EXACT_CHUNKS/)
		expect(() => ragequitChunks([10n], 0n)).toThrow(/NO_EXACT_CHUNKS/)
		expect(() => ragequitChunks([10n], 11n)).toThrow(/NO_EXACT_CHUNKS/)
	})
})
