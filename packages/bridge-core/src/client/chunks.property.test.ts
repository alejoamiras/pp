import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../../vitest.base"
import { ragequitChunks } from "./chunks"
import { BridgeClientError } from "./errors"

// The labelled token pops at most this many notes per burn (`MAX_NOTES` in its `balance_set.nr`).
const BURN_CAP = 8
const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n)
const descending = (xs: readonly bigint[]) => [...xs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))

const small = fc.bigInt({ min: 1n, max: 12n })
// Up to 2^123, so that 26 notes still sum within a u128, as the token's own balance does.
const large = fc.bigInt({ min: 1n, max: 2n ** 123n })
const U128_MAX = 2n ** 128n - 1n
// `size: "max"`, or fast-check keeps lists near ten notes and never reaches a third chunk.
const list = (v: fc.Arbitrary<bigint>) => fc.array(v, { maxLength: 3 * BURN_CAP + 2, size: "max" })
/**
 * One value regime per list: only small or equal values tie across a chunk boundary, as fixed
 * denominations do; large ones keep bigint honest.
 */
const notes = fc.oneof(
	list(small),
	list(large),
	list(fc.oneof(small, large)),
	fc.tuple(fc.nat(3 * BURN_CAP + 2), small).map(([n, v]) => Array<bigint>(n).fill(v)),
)

const amountFor = (ns: readonly bigint[]): fc.Arbitrary<bigint | undefined> => {
	const prefix = fc.nat(ns.length).map((k) => sum(descending(ns).slice(0, k)))
	return fc.oneof(
		fc.constant(undefined),
		prefix,
		prefix.chain((p) => fc.constantFrom(p - 1n, p + 1n)),
		fc.bigInt({ min: -2n, max: sum(ns) + 2n }),
	)
}

const exactPrefix = (ns: readonly bigint[], amount: bigint) => {
	const d = descending(ns)
	return d.some((_, i) => sum(d.slice(0, i + 1)) === amount)
}

/**
 * Burns each chunk in turn with the note selection a burn runs, the largest remaining notes until their
 * sum reaches the chunk, and returns the notes left. Throws where a chunk burns nothing (the token
 * refuses a zero amount), leaves change or takes too many notes.
 */
function burnAll(ns: readonly bigint[], chunks: readonly bigint[]): bigint[] {
	let left = [...ns]
	for (const chunk of chunks) {
		if (chunk <= 0n) throw new Error(`chunk ${chunk} burns nothing`)
		const d = descending(left)
		let taken = 0
		let total = 0n
		while (total < chunk && taken < d.length) total += d[taken++] as bigint
		if (total !== chunk) throw new Error(`chunk ${chunk} selects ${total}: a change note`)
		if (taken > BURN_CAP) throw new Error(`chunk ${chunk} selects ${taken} notes`)
		left = d.slice(taken)
	}
	return left
}

const outcome = (ns: readonly bigint[], amount: bigint | undefined): bigint[] | "NO_EXACT_CHUNKS" => {
	try {
		return ragequitChunks(ns, amount)
	} catch (e) {
		if (e instanceof BridgeClientError && e.code === "NO_EXACT_CHUNKS") return "NO_EXACT_CHUNKS"
		throw e
	}
}

describe("ragequitChunks", () => {
	const name = "chunks burn exactly under the standard selection, for any note order"
	const p = propertyParams(import.meta.url, name, 300, 1_000)
	it(
		name,
		() => {
			const input = notes.chain((ns) => fc.tuple(fc.constant(ns), amountFor(ns), fc.shuffledSubarray(ns, { minLength: ns.length })))
			fc.assert(
				fc.property(input, ([ns, amount, shuffled]) => {
					const got = outcome(ns, amount)
					expect(outcome(shuffled, amount), "the result does not depend on note order").toEqual(got)
					const exact = amount === undefined || exactPrefix(ns, amount)
					expect(got === "NO_EXACT_CHUNKS", "NO_EXACT_CHUNKS iff no non-empty descending prefix sums to the amount").toBe(!exact)
					if (got === "NO_EXACT_CHUNKS") return
					expect(sum(got), "the chunks sum to the amount, or to the balance").toBe(amount ?? sum(ns))
					expect(sum(burnAll(ns, got)), "burning every chunk leaves balance − amount").toBe(sum(ns) - (amount ?? sum(ns)))
				}),
				{ ...p.fc, examples: [[[[U128_MAX], undefined, [U128_MAX]]]] },
			)
		},
		p.testTimeout,
	)
})
