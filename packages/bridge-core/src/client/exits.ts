import type { Hash, Hex } from "viem"
import { BridgeClientError } from "./errors"
import type { ExitStatus, ExitTicket } from "./types"

/** One page of a cursor-paged query; `next` is absent once the range is exhausted. */
export type Page<T, C> = { items: T[]; next?: C }

/** Reads every page: the SDK's event query returns one page and a cursor, never the whole range. */
export async function allPages<T, C>(fetch: (after: C | undefined) => Promise<Page<T, C>>): Promise<T[]> {
	const out: T[] = []
	let after: C | undefined
	do {
		const page = await fetch(after)
		out.push(...page.items)
		after = page.next
	} while (after !== undefined)
	return out
}

/**
 * Each ticket's index among its transaction's L2→L1 messages, the index a membership witness
 * needs. Tickets arrive in emission order; the k-th ticket with a given message hash is the k-th
 * occurrence of that hash, so identical exits in one transaction stay distinct.
 *
 * @throws BridgeClientError `RPC_INCONSISTENT` when a ticket has no matching message left
 */
export function messageIndices(ticketHashes: readonly Hex[], messagesInTx: readonly Hex[]): number[] {
	const used = new Set<number>()
	return ticketHashes.map((h) => {
		const i = messagesInTx.findIndex((m, j) => !used.has(j) && m.toLowerCase() === h.toLowerCase())
		if (i < 0) throw new BridgeClientError("RPC_INCONSISTENT")
		used.add(i)
		return i
	})
}

/** A ticket's identity on L1: the Outbox `(epoch, leafId)` its witness proves. */
export type ExitWitness = { epoch: bigint; leafId: bigint }

/** The L1 header one decision's reads are bound to. */
export type ExitPin = { number: bigint; hash: Hash }

export type ExitReads<W extends ExitWitness = ExitWitness> = {
	/** The endpoint's latest header, at or above `floor` (such as a receipt's block: a backend can lag the one that served it). */
	pin(floor?: bigint): Promise<ExitPin>
	/** @throws BridgeClientError `RPC_INCONSISTENT` unless `at` is still the header at its height. */
	holds(at: ExitPin): Promise<void>
	/** The ticket's witness once an Outbox root at `at` covers it. */
	witness(t: ExitTicket, at: ExitPin): Promise<W | undefined>
	/**
	 * The transaction of the portal's `ExitSettled` with exactly this pair up to `at`, if any.
	 * @throws BridgeClientError `RPC_INCONSISTENT` when that event's payee, amount or label is not the
	 * ticket's, or its block is not canonical
	 */
	settledTx(t: ExitTicket, w: ExitWitness, at: ExitPin): Promise<Hash | null>
	/** Whether the Outbox had consumed the pair at `at`. */
	consumed(w: ExitWitness, at: ExitPin): Promise<boolean>
}

export type ExitState<W extends ExitWitness = ExitWitness> =
	| { status: "proving" }
	| { status: "ready"; witness: W }
	| { status: "settled"; tx: Hash }

/** `read` at one fresh header at or above `floor`, which must still be canonical once `read` returns. */
async function atOnePin<W extends ExitWitness, T>(
	io: ExitReads<W>,
	floor: bigint | undefined,
	read: (at: ExitPin) => Promise<T>,
): Promise<[T, ExitPin]> {
	const at = await io.pin(floor)
	const value = await read(at)
	await io.holds(at)
	return [value, at]
}

/** The transaction that settled `t` at `w`, read at a fresh header at or above `floor`. */
export async function settledAt<W extends ExitWitness>(
	io: ExitReads<W>,
	t: ExitTicket,
	w: ExitWitness,
	floor?: bigint,
): Promise<Hash | null> {
	const [tx] = await atOnePin(io, floor, (at) => io.settledTx(t, w, at))
	return tx
}

type Decision<W extends ExitWitness> = ExitState<W> | { status: "consumed"; witness: W }

/**
 * Every read of one decision is bound to one header: the Outbox root and the consumed flag at its
 * hash, the event scan up to it. `settled` needs the portal's event for the exact pair; a leaf
 * consumed with no event at the same header (the consume and the event are one transaction) is
 * re-read once at a later header and then reported.
 * @throws BridgeClientError `RPC_INCONSISTENT` when the header moved during the reads, or as `settledTx` does
 */
export async function exitState<W extends ExitWitness>(io: ExitReads<W>, t: ExitTicket): Promise<ExitState<W>> {
	const [s, at] = await atOnePin(io, undefined, async (at): Promise<Decision<W>> => {
		const witness = await io.witness(t, at)
		if (!witness) return { status: "proving" }
		const tx = await io.settledTx(t, witness, at)
		if (tx) return { status: "settled", tx }
		return (await io.consumed(witness, at)) ? { status: "consumed", witness } : { status: "ready", witness }
	})
	if (s.status !== "consumed") return s
	const reread = await settledAt(io, t, s.witness, at.number)
	if (reread) return { status: "settled", tx: reread }
	throw new BridgeClientError("RPC_INCONSISTENT")
}

export const exitStatusOf = (s: ExitState<ExitWitness>): ExitStatus => s.status

/**
 * Settles a ready ticket, or returns the transaction that already did. If another payer settles
 * between the read and the send, the send reverts and the exact pair's event names that payer's
 * transaction.
 */
export async function settleWith<W extends ExitWitness>(io: ExitReads<W>, t: ExitTicket, send: (w: W) => Promise<Hash>): Promise<Hash> {
	const s = await exitState(io, t)
	if (s.status === "settled") return s.tx
	if (s.status === "proving") throw new BridgeClientError("EXIT_NOT_READY")
	try {
		return await send(s.witness)
	} catch (e) {
		// The send's own error (an UNCERTAIN carries its hash) outlives a failed re-read.
		const raced = await settledAt(io, t, s.witness).catch(() => null)
		if (raced) return raced
		throw e
	}
}
