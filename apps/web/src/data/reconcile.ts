/**
 * The pool side as the page shows it after any load, reload included. The session's journal writes a
 * record before its Ethereum transaction and adds the hash only when the wallet returns one, so a
 * reload mid-send leaves a record with no hash. Such a bridge may be in flight: until the chain shows
 * it (`recover`) or its note is gone, the note stays closed to a second bridge.
 */
import type { BridgeRecordView, PoolNoteStatus, PoolNoteView } from "./a7"
import type { Session } from "./ports"

export interface PoolState {
	notes: PoolNoteView[]
	/** Unclaimed bridges the chain shows, to follow and claim. */
	bridges: BridgeRecordView[]
	/** Records that may be in flight, by their note's commitment. */
	inFlight: ReadonlyMap<bigint, BridgeRecordView>
	/** Records with no hash whose note is gone and which the chain does not show as this bridge. */
	consumed: BridgeRecordView[]
	/** Each open record's note (spent once mined), by record id: where its label and value come from. */
	noteOf: ReadonlyMap<string, PoolNoteView>
}

const GONE: ReadonlySet<PoolNoteStatus> = new Set(["spent", "exiting", "exited"])

const isOpen = (r: BridgeRecordView) => typeof r.step !== "object" && r.step !== "claimed"

/** `unspent` maps each unspent note's nullifier to the note; `recovered` is `recover` for the records' recipients. */
export function reconcile(
	records: readonly BridgeRecordView[],
	recovered: readonly BridgeRecordView[],
	unspent: ReadonlyMap<bigint, PoolNoteView>,
): Pick<PoolState, "bridges" | "inFlight" | "consumed"> {
	const bridges: BridgeRecordView[] = []
	const inFlight = new Map<bigint, BridgeRecordView>()
	const consumed: BridgeRecordView[] = []
	for (const r of records.filter(isOpen)) {
		const seen = r.l1TxHash ? r : recovered.find((x) => x.id === r.id)
		const note = unspent.get(r.nullifier)
		if (seen) bridges.push(seen)
		else if (note) inFlight.set(note.commitment, r)
		else consumed.push(r)
	}
	return { bridges, inFlight, consumed }
}

/** Reads notes and records, and reconciles a hashless record against the note's status and `recover`. */
export async function readPool(session: Session): Promise<PoolState> {
	const [notes, records] = await Promise.all([session.notes(), session.records()])
	const open = records.filter(isOpen)
	if (open.length === 0) return { notes, bridges: [], inFlight: new Map(), consumed: [], noteOf: new Map() }
	const nullifiers = await Promise.all(notes.map((n) => session.nullifierOf(n.commitment)))
	const byNullifier = new Map(notes.map((n, i) => [nullifiers[i] as bigint, n]))
	const recipients = [...new Set(open.filter((r) => !r.l1TxHash).map((r) => r.recipient))]
	const recovered = (await Promise.all(recipients.map((a) => session.recover(a)))).flat()
	const unspent = new Map([...byNullifier].filter(([, n]) => !GONE.has(n.status)))
	const noteOf = new Map(
		open.flatMap((r) => (byNullifier.has(r.nullifier) ? [[r.id, byNullifier.get(r.nullifier) as PoolNoteView] as const] : [])),
	)
	return { notes, noteOf, ...reconcile(open, recovered, unspent) }
}
