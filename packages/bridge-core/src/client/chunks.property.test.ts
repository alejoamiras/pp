import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../../vitest.base"
import { MAX_NOTES_PER_BURN, ragequitChunks } from "./chunks"
import { BridgeClientError } from "./errors"

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n)
const descending = (xs: readonly bigint[]) => [...xs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))

/** Small values repeat and tie, so exact prefixes, ties and near misses are common; large ones keep bigint honest. */
const value = fc.oneof(fc.bigInt({ min: 1n, max: 12n }), fc.bigInt({ min: 1n, max: 2n ** 80n }))
const notes = fc.array(value, { maxLength: 3 * MAX_NOTES_PER_BURN + 2 })

/** An amount a descending prefix reaches, one beside it, or anything at all, including none and non-positive. */
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
 * Burns each chunk in turn with the note selection a burn runs: the largest remaining notes until
 * their sum reaches the chunk. Throws where a chunk would leave change or take too many notes.
 * @returns the notes left after the last chunk
 */
function burnAll(ns: readonly bigint[], chunks: readonly bigint[]): bigint[] {
	let left = [...ns]
	for (const chunk of chunks) {
		const d = descending(left)
		let taken = 0
		let total = 0n
		while (total < chunk && taken < d.length) total += d[taken++] as bigint
		if (total !== chunk) throw new Error(`chunk ${chunk} selects ${total}: a change note`)
		if (taken > MAX_NOTES_PER_BURN) throw new Error(`chunk ${chunk} selects ${taken} notes`)
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
	const p = propertyParams(import.meta.url, name, 300, 500)
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
				p.fc,
			)
		},
		p.testTimeout,
	)
})
