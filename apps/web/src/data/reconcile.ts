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
import { codeOf } from "./errors"
import type { L1TxState, Session } from "./ports"
import type { AztecAddress, BridgeRecordView, PoolNoteStatus, PoolNoteView } from "./stack-types"

export interface PoolState {
	notes: PoolNoteView[]
	/** Unclaimed bridges the chain shows, to follow and claim. */
	bridges: BridgeRecordView[]
	/** Records whose transaction is pending at the RPC, by their note's commitment: wait, send nothing. */
	inFlight: ReadonlyMap<bigint, BridgeRecordView>
	/** Records the chain shows nothing for while their note is unspent, by commitment: check or send again. */
	uncertain: ReadonlyMap<bigint, BridgeRecordView>
	/** The same, for a note this page is sending now, by commitment: its bridge screen follows it, nothing else is sent. */
	sending: ReadonlyMap<bigint, BridgeRecordView>
	/** Records whose note was spent without this bridge's event. */
	consumed: BridgeRecordView[]
	/** Each bridge's or open record's note (spent once mined), by record id: where its label and value come from. */
	noteOf: ReadonlyMap<string, PoolNoteView>
	/** The session has no bridge part in this build: notes only, and no bridge to start. */
	bridgeUnavailable: boolean
}

const GONE: ReadonlySet<PoolNoteStatus> = new Set(["spent", "exiting", "exited"])

const isOpen = (r: BridgeRecordView) => typeof r.step !== "object" && r.step !== "claimed"

/** What an open record's attempt is on chain: a bridge to follow, pending at the RPC, unconfirmed, or beaten to its note. */
export type PriorKind = "bridge" | "in-flight" | "uncertain" | "consumed"

/** `seen`: `recover` found the record's event; `tx`: the RPC's answer for its hash; `unspent`: its note. */
function classify(seen: boolean, tx: L1TxState | undefined, unspent: boolean): PriorKind {
	if (seen || tx === "mined") return "bridge"
	if (unspent && tx === "pending") return "in-flight"
	return unspent ? "uncertain" : "consumed"
}

/**
 * `recovered` is `recover` for the recipients, `unspent` maps each unspent note's nullifier to the note,
 * `txs` holds the RPC's answer for each open record's hash, and `submitting` lists the notes this page
 * is sending now. A send waiting on its wallet has a record with no hash, which is unconfirmed only once
 * no live Submit owns it.
 */
export function reconcile(
	records: readonly BridgeRecordView[],
	recovered: readonly BridgeRecordView[],
	unspent: ReadonlyMap<bigint, PoolNoteView>,
	txs: ReadonlyMap<Hash, L1TxState>,
	submitting: ReadonlySet<bigint> = new Set(),
): Pick<PoolState, "bridges" | "inFlight" | "uncertain" | "sending" | "consumed"> {
	const bridges: BridgeRecordView[] = []
	const open = { "in-flight": new Map<bigint, BridgeRecordView>(), uncertain: new Map<bigint, BridgeRecordView>() }
	const sending = new Map<bigint, BridgeRecordView>()
	const consumed: BridgeRecordView[] = []
	for (const r of records.filter(isOpen)) {
		const seen = recovered.find((x) => x.id === r.id)
		const note = unspent.get(r.nullifier)
		const kind = classify(seen !== undefined, r.l1TxHash ? txs.get(r.l1TxHash) : undefined, note !== undefined)
		if (kind === "bridge") bridges.push(seen ?? r)
		else if (kind === "consumed" || note === undefined) consumed.push(r)
		else (kind === "uncertain" && submitting.has(note.commitment) ? sending : open[kind]).set(note.commitment, r)
	}
	const known = new Set(records.map((r) => r.id))
	bridges.push(...recovered.filter((x) => !known.has(x.id)))
	return { bridges, inFlight: open["in-flight"], uncertain: open.uncertain, sending, consumed }
}

export interface Prior {
	kind: PriorKind
	/** The chain's copy when `recover` found it, else the journal's. */
	record: BridgeRecordView
}

/** The note's open journal record, read against the chain exactly as `reconcile` reads it; `null` when it has none. */
export async function priorAttempt(session: Session, commitment: bigint): Promise<Prior | null> {
	const [nullifier, records, notes] = await Promise.all([session.nullifierOf(commitment), session.records(), session.notes()])
	const r = records.find((x) => isOpen(x) && x.nullifier === nullifier)
	if (!r) return null
	const [recovered, tx] = await Promise.all([session.recover(r.recipient), r.l1TxHash ? session.l1TxState(r.l1TxHash) : undefined])
	const seen = recovered.find((x) => x.id === r.id)
	const note = notes.find((n) => n.commitment === commitment)
	return { kind: classify(seen !== undefined, tx, note !== undefined && !GONE.has(note.status)), record: seen ?? r }
}

/**
 * Reads notes, records and what the chain shows for them; `connected` are the Aztec accounts to recover
 * for, and `submitting` the notes this page is sending now (read after the records, so a send that
 * settles meanwhile is not taken for a live one).
 */
export async function readPool(
	session: Session,
	connected: readonly AztecAddress[],
	submitting: () => ReadonlySet<bigint> = () => new Set(),
): Promise<PoolState> {
	const [notes, records] = await Promise.all([session.notes(), journal(session)])
	const notesOnly = (bridgeUnavailable: boolean): PoolState => ({
		notes,
		bridges: [],
		inFlight: new Map(),
		uncertain: new Map(),
		sending: new Map(),
		consumed: [],
		noteOf: new Map(),
		bridgeUnavailable,
	})
	if (records === null) return notesOnly(true)
	const open = records.filter(isOpen)
	const recipients = [...new Set([...connected, ...open.map((r) => r.recipient)])]
	if (recipients.length === 0) return notesOnly(false)
	const hashes = [...new Set(open.flatMap((r) => (r.l1TxHash ? [r.l1TxHash] : [])))]
	const [nullifiers, recovered, states] = await Promise.all([
		Promise.all(notes.map((n) => session.nullifierOf(n.commitment))),
		Promise.all(recipients.map((a) => session.recover(a))),
		Promise.all(hashes.map((h) => session.l1TxState(h))),
	])
	const byNullifier = new Map(notes.map((n, i) => [nullifiers[i] as bigint, n]))
	const unspent = new Map([...byNullifier].filter(([, n]) => !GONE.has(n.status)))
	const txs = new Map(hashes.map((h, i) => [h, states[i] as L1TxState]))
	const found = reconcile(records, recovered.flat(), unspent, txs, submitting())
	const noteOf = new Map(
		[...open, ...found.bridges].flatMap((r) => {
			const note = byNullifier.get(r.nullifier)
			return note ? [[r.id, note] as const] : []
		}),
	)
	return { notes, noteOf, ...found, bridgeUnavailable: false }
}

/** The session's journal, or `null` when this build's session has no bridge part. */
async function journal(session: Session): Promise<BridgeRecordView[] | null> {
	try {
		return await session.records()
	} catch (err) {
		if (codeOf(err) === "BRIDGE_UNAVAILABLE") return null
		throw err
	}
}
