import { type Address, type Hex, isAddressEqual } from "viem"
import { PoolClientError, type SpendCheck } from "./errors.ts"
import type { ChangeOpening, NoteData, PreparedSpend } from "./types.ts"

/** What the caller asked for (captured before the first await) and the note it chose (read after sync). */
export type Expected = {
	processor: Address
	data: Hex
	amount: bigint
	asset: Address
	spentCommitment: bigint
	label: bigint
	value: bigint
}

export type TransactParams = { processor: Address; data: Hex }

/** Everything the checks derive from the user's keys, so this module stays pure. */
export type SpendKeys = {
	nullifierOf(commitment: bigint): bigint
	open(noteData: NoteData): { opening: ChangeOpening; asset: Address } | null
	contextOf(params: TransactParams, noteData: readonly NoteData[]): bigint
}

const fail = (check: SpendCheck, why: string) => new PoolClientError("SPEND_CHECK_FAILED", `${check}: ${why}`, { check })

function shape(s: PreparedSpend): void {
	const rows = s.proof.pubSignals
	if (rows.length !== 8 || rows.some((r) => r.length !== 1)) throw fail("shape", "expected eight public-signal rows of one")
	if (s.noteData.length !== 1) throw fail("shape", `expected one NoteData, got ${s.noteData.length}`)
}

const sameOpening = (a: ChangeOpening, b: ChangeOpening) =>
	a.commitment === b.commitment && a.precommitment === b.precommitment && a.label === b.label && a.value === b.value

function change(s: PreparedSpend, e: Expected, k: SpendKeys, signal: (row: number) => bigint): void {
	const opened = k.open(s.noteData[0]!)
	if (opened === null) throw fail("change", "noteData does not decrypt to this user's keys")
	const { opening, asset } = opened
	if (opening.commitment !== signal(1)) throw fail("change", "decrypted commitment differs from the proof's output")
	if (!sameOpening(opening, s.change)) throw fail("change", "decrypted opening differs from the returned one")
	if (opening.label !== e.label) throw fail("change", "change label differs from the spent note's")
	if (opening.value !== e.value - e.amount) throw fail("change", "change value is not the note's value minus the amount")
	if (!isAddressEqual(asset, e.asset)) throw fail("change", "change asset differs")
}

/**
 * Proves the spend is the one requested and recoverable, or throws `SPEND_CHECK_FAILED` naming the first
 * failed check. `change` precedes `context`, so a corrupted `noteData` is reported as unrecoverable change.
 */
export function checkSpend(s: PreparedSpend, params: TransactParams, e: Expected, k: SpendKeys): void {
	shape(s)
	const signal = (row: number) => s.proof.pubSignals[row]![0]!
	if (
		!isAddressEqual(s.processor, e.processor) ||
		s.data !== e.data ||
		s.amount !== e.amount ||
		!isAddressEqual(s.asset, e.asset) ||
		s.spentCommitment !== e.spentCommitment
	)
		throw fail("request", "the spend does not match the request")
	if (!isAddressEqual(params.processor, e.processor) || params.data !== e.data)
		throw fail("params", "transact params differ from the request")
	if (signal(5) !== e.amount || signal(6) !== BigInt(e.asset) || signal(4) !== s.aspRoot)
		throw fail("public", "amount, asset or ASP root differ from the proof's public signals")
	const nullifier = k.nullifierOf(e.spentCommitment)
	if (nullifier !== signal(0) || nullifier !== s.nullifier) throw fail("nullifier", "the proof does not nullify the requested note")
	change(s, e, k, signal)
	if (signal(7) !== k.contextOf(params, s.noteData)) throw fail("context", "the proof's context does not bind params and noteData")
}
