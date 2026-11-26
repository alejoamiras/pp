import { BridgeClientError } from "./errors"

/** `burn_for_exit` consumes at most this many notes per call. */
export const MAX_NOTES_PER_BURN = 8

/**
 * The amounts to burn, one `ragequit` call each, so that every call consumes whole notes and makes
 * no change note (a change note is a constrained self-send that a reverted send can block).
 *
 * `burn_for_exit` sorts the label's notes by value, largest first, and takes them until their sum
 * reaches the amount, so an amount burns exactly when it equals the sum of a descending prefix.
 * Each chunk is therefore the next ≤ 8 notes of the descending order.
 *
 * @param noteValues the values of one label's notes (one origin), as `private_notes_by_label` returns them
 * @param amount the total to exit; omitted, the whole balance
 * @throws BridgeClientError `NO_EXACT_CHUNKS` when no descending prefix sums to `amount`
 */
export function ragequitChunks(noteValues: readonly bigint[], amount?: bigint): bigint[] {
	if (noteValues.some((v) => v <= 0n)) throw new TypeError("note values must be positive")
	const sorted = [...noteValues].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
	const count = amount === undefined ? sorted.length : prefixLength(sorted, amount)
	const chunks: bigint[] = []
	for (let i = 0; i < count; i += MAX_NOTES_PER_BURN) {
		chunks.push(sorted.slice(i, Math.min(i + MAX_NOTES_PER_BURN, count)).reduce((sum, v) => sum + v, 0n))
	}
	return chunks
}

function prefixLength(sorted: readonly bigint[], amount: bigint): number {
	let sum = 0n
	for (let i = 0; i < sorted.length && sum < amount; i++) {
		sum += sorted[i] as bigint
		if (sum === amount) return i + 1
	}
	throw new BridgeClientError("NO_EXACT_CHUNKS")
}
