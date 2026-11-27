import type { RagequitChunks } from "./stack-types"
import { BridgeFailure } from "./errors"

/** `burn_for_exit` consumes at most this many notes per call. */
export const MAX_NOTES_PER_BURN = 8

const desc = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0)

/**
 * Exact ragequit chunks, as `burn_for_exit` consumes them: it sorts the label's notes largest first and
 * takes them until the sum reaches the amount, at most 8 per call, so each chunk is a descending prefix
 * of the notes left. With no amount, the whole balance; with one, the prefix summing to it exactly, or
 * `NO_EXACT_CHUNKS` ([10, 6, 4] with 6 is refused: the contract would take the 10).
 */
export const ragequitChunks: RagequitChunks = (noteValues, amount) => {
	const sorted = noteValues.filter((v) => v > 0n).sort(desc)
	let take = sorted.length
	if (amount !== undefined) {
		let sum = 0n
		take = -1
		for (let i = 0; i < sorted.length && sum < amount; i++) {
			sum += sorted[i] ?? 0n
			if (sum === amount) take = i + 1
		}
		if (amount <= 0n || take < 0) throw new BridgeFailure("NO_EXACT_CHUNKS")
	}
	const chunks: bigint[] = []
	for (let i = 0; i < take; i += MAX_NOTES_PER_BURN)
		chunks.push(sorted.slice(i, Math.min(i + MAX_NOTES_PER_BURN, take)).reduce((a, b) => a + b, 0n))
	return chunks
}

/** Every amount one ragequit call can take exactly: the sums of the 1 to 8 largest notes. */
export function singleCallAmounts(noteValues: readonly bigint[]): bigint[] {
	const sorted = noteValues.filter((v) => v > 0n).sort(desc)
	const out: bigint[] = []
	let sum = 0n
	for (const v of sorted.slice(0, MAX_NOTES_PER_BURN)) {
		sum += v
		out.push(sum)
	}
	return out
}
