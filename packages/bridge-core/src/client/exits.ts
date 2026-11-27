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

export type ExitReads<W extends ExitWitness = ExitWitness> = {
	witness(t: ExitTicket): Promise<W | undefined>
	/**
	 * The transaction of the portal's `ExitSettled` with exactly this pair, if any. The scan reaches at
	 * least `floor`, such as a receipt's block: a node can lag the one that served the receipt.
	 */
	settledTx(w: ExitWitness, floor?: bigint): Promise<Hash | null>
	consumed(w: ExitWitness): Promise<boolean>
}

export type ExitState<W extends ExitWitness = ExitWitness> =
	| { status: "proving" }
	| { status: "ready"; witness: W }
	| { status: "settled"; tx: Hash }

/**
 * `settled` needs the portal's event for the exact pair; a consumed leaf whose event the RPC does
 * not show is re-read once (the consume and the event are one transaction) and then reported.
 */
export async function exitState<W extends ExitWitness>(io: ExitReads<W>, t: ExitTicket): Promise<ExitState<W>> {
	const witness = await io.witness(t)
	if (!witness) return { status: "proving" }
	const settled = await io.settledTx(witness)
	if (settled) return { status: "settled", tx: settled }
	if (!(await io.consumed(witness))) return { status: "ready", witness }
	const reread = await io.settledTx(witness)
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
		const raced = await io.settledTx(s.witness).catch(() => null)
		if (raced) return raced
		throw e
	}
}
