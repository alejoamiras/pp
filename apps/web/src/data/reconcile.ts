/**
 * The pool side as the page shows it after any load, reload included. A journal record is written
 * before its Ethereum transaction and gains the hash only when the wallet returns one, and a stored
 * hash is no proof of a send, so each open record is read against the chain: the bridge's event
 * (`recover`) or a mined hash make it a bridge to follow; a hash pending at the RPC is in flight; no
 * hash, or one the RPC does not know, is uncertain while the note is unspent; a note spent without the
 * event was consumed elsewhere. `recover` also runs for the connected accounts, so a mined bridge shows
 * on a device that has no journal for it.
 */
import type { Hash } from "viem"
import type { AztecAddress, BridgeRecordView, PoolNoteStatus, PoolNoteView } from "./stack-types"
import type { L1TxState, Session } from "./ports"

export interface PoolState {
	notes: PoolNoteView[]
	/** Unclaimed bridges the chain shows, to follow and claim. */
	bridges: BridgeRecordView[]
	/** Records whose transaction is pending at the RPC, by their note's commitment: wait, send nothing. */
	inFlight: ReadonlyMap<bigint, BridgeRecordView>
	/** Records the chain shows nothing for while their note is unspent, by commitment: check or send again. */
	uncertain: ReadonlyMap<bigint, BridgeRecordView>
	/** Records whose note was spent without this bridge's event. */
	consumed: BridgeRecordView[]
	/** Each bridge's or open record's note (spent once mined), by record id: where its label and value come from. */
	noteOf: ReadonlyMap<string, PoolNoteView>
}

const GONE: ReadonlySet<PoolNoteStatus> = new Set(["spent", "exiting", "exited"])

const isOpen = (r: BridgeRecordView) => typeof r.step !== "object" && r.step !== "claimed"

/**
 * `recovered` is `recover` for the recipients, `unspent` maps each unspent note's nullifier to the note,
 * and `txs` holds the RPC's answer for each open record's hash.
 */
export function reconcile(
	records: readonly BridgeRecordView[],
	recovered: readonly BridgeRecordView[],
	unspent: ReadonlyMap<bigint, PoolNoteView>,
	txs: ReadonlyMap<Hash, L1TxState>,
): Pick<PoolState, "bridges" | "inFlight" | "uncertain" | "consumed"> {
	const bridges: BridgeRecordView[] = []
	const inFlight = new Map<bigint, BridgeRecordView>()
	const uncertain = new Map<bigint, BridgeRecordView>()
	const consumed: BridgeRecordView[] = []
	for (const r of records.filter(isOpen)) {
		const seen = recovered.find((x) => x.id === r.id)
		const tx = r.l1TxHash ? txs.get(r.l1TxHash) : undefined
		const note = unspent.get(r.nullifier)
		if (seen || tx === "mined") bridges.push(seen ?? r)
		else if (note && tx === "pending") inFlight.set(note.commitment, r)
		else if (note) uncertain.set(note.commitment, r)
		else consumed.push(r)
	}
	const known = new Set(records.map((r) => r.id))
	bridges.push(...recovered.filter((x) => !known.has(x.id)))
	return { bridges, inFlight, uncertain, consumed }
}

/** Reads notes, records and what the chain shows for them; `connected` are the Aztec accounts to recover for. */
export async function readPool(session: Session, connected: readonly AztecAddress[]): Promise<PoolState> {
	const [notes, records] = await Promise.all([session.notes(), session.records()])
	const open = records.filter(isOpen)
	const recipients = [...new Set([...connected, ...open.map((r) => r.recipient)])]
	if (recipients.length === 0) return { notes, bridges: [], inFlight: new Map(), uncertain: new Map(), consumed: [], noteOf: new Map() }
	const hashes = [...new Set(open.flatMap((r) => (r.l1TxHash ? [r.l1TxHash] : [])))]
	const [nullifiers, recovered, states] = await Promise.all([
		Promise.all(notes.map((n) => session.nullifierOf(n.commitment))),
		Promise.all(recipients.map((a) => session.recover(a))),
		Promise.all(hashes.map((h) => session.l1TxState(h))),
	])
	const byNullifier = new Map(notes.map((n, i) => [nullifiers[i] as bigint, n]))
	const unspent = new Map([...byNullifier].filter(([, n]) => !GONE.has(n.status)))
	const found = reconcile(records, recovered.flat(), unspent, new Map(hashes.map((h, i) => [h, states[i] as L1TxState])))
	const noteOf = new Map(
		[...open, ...found.bridges].flatMap((r) => {
			const note = byNullifier.get(r.nullifier)
			return note ? [[r.id, note] as const] : []
		}),
	)
	return { notes, noteOf, ...found }
}
