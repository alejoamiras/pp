import { useApp } from "../../app/context"
import { usePool } from "../../app/queries"
import { awaitsWallet } from "../../data/bridge-machine"
import type { BridgeRecordView, PoolNoteView } from "../../data/stack-types"
import { messageOf, UNCERTAIN_WORST_CASE } from "../../data/errors"
import { type NoteRow, poolNotesView } from "../../data/model"
import type { Session } from "../../data/ports"
import type { PoolState } from "../../data/reconcile"
import { ActionButton, Amount, Callout, EmptyState, LabelChip, Panel, StateBadge, shortHex } from "../../ui"
import { TITLES } from "../bridge/Failure"
import { EthereumSignIn } from "../connect/EthereumSignIn"

const BUSY = new Set(["starting", "proving", "sending", "preflight"])

/** Why the bridge on screen must not be replaced by another, or `undefined`. */
function useScreenHeld(): string | undefined {
	const { bridge } = useApp()
	if (bridge.subject && awaitsWallet(bridge.machine)) return "Your Ethereum wallet has not answered the bridge in progress yet."
	return undefined
}

/** Why this note's bridge cannot start, or `undefined`. */
function useBridgeBlock(): string | undefined {
	const { connection, refusal, bridge } = useApp()
	const held = useScreenHeld()
	if (!connection) return "Connect your Aztec wallet first: the bridge pays into its account."
	if (refusal("claim") !== null) return "Your Aztec wallet did not allow claiming. Connect again and allow it."
	if (bridge.subject && BUSY.has(bridge.machine.phase)) return "Finish the bridge in progress first."
	return held
}

/** A record whose transaction the RPC holds unmined: its hash, and no send until it lands or drops. */
function InFlightNote({ record }: { record: BridgeRecordView }) {
	return (
		<Callout tone="wait" title={TITLES.IN_FLIGHT} role="status">
			<p>{messageOf("IN_FLIGHT")}</p>
			<p className="mt-1 font-mono text-xs break-all" data-testid="pending-tx">
				{record.l1TxHash}
			</p>
		</Callout>
	)
}

/** This page's own send, its wallet request still unanswered (perhaps from before a sign-out): nothing is offered. */
function SendingNote() {
	return (
		<Callout tone="wait" title="Bridge in progress" role="status">
			<p>Your Ethereum wallet has not answered this bridge yet. Nothing more is sent for this note until it does.</p>
		</Callout>
	)
}

/** A record the chain shows nothing for: Check again asks the session without the override; Send again passes it. */
function UncertainNote({ note, record }: { note: PoolNoteView; record: BridgeRecordView }) {
	const { bridge, go } = useApp()
	const block = useBridgeBlock()
	const retry = (acceptUncertain: boolean) => {
		void bridge.retry(note, record, acceptUncertain)
		go("bridge")
	}
	return (
		<Callout tone="attn" title={TITLES.UNCERTAIN} role="status">
			<p>{messageOf("UNCERTAIN")}</p>
			<p className="mt-1 font-semibold">{UNCERTAIN_WORST_CASE}</p>
			<div className="mt-2 flex flex-wrap gap-2">
				<ActionButton disabledReason={block} onClick={() => retry(false)}>
					Check again
				</ActionButton>
				<ActionButton variant="primary" disabledReason={block} onClick={() => retry(true)}>
					Send again
				</ActionButton>
			</div>
		</Callout>
	)
}

function NoteItem({ row, pool }: { row: NoteRow; pool: PoolState }) {
	const { source, bridge, go } = useApp()
	const block = useBridgeBlock()
	const { note } = row
	const inFlight = pool.inFlight.get(note.commitment)
	const uncertain = pool.uncertain.get(note.commitment)
	const sending = pool.sending.has(note.commitment)
	const open = (n: PoolNoteView) => {
		bridge.open(n)
		go("bridge")
	}
	return (
		<li
			data-testid="note-row"
			data-commitment={note.commitment.toString()}
			className="grid gap-2 rounded-row border border-edge bg-glass-2 px-3 py-2.5"
		>
			<div className="flex flex-wrap items-center justify-between gap-2.5">
				<LabelChip label={note.label} />
				<Amount value={note.value} decimals={source.deployment.decimals} symbol={source.deployment.symbol} />
			</div>
			<div className="flex flex-wrap items-center gap-2 text-meta text-ink-2">
				<StateBadge tone={row.tone}>{row.text}</StateBadge>
				<span>Pool note</span>
			</div>
			{inFlight ? (
				<InFlightNote record={inFlight} />
			) : sending ? (
				<SendingNote />
			) : uncertain ? (
				<UncertainNote note={note} record={uncertain} />
			) : row.blocked ? (
				<p className="text-xs text-ink-3">{row.blocked}</p>
			) : (
				<ActionButton variant="primary" disabledReason={block} onClick={() => open(note)}>
					Bridge to Aztec
				</ActionButton>
			)}
		</li>
	)
}

const STEP_TEXT: Record<string, string> = {
	submitted: "Sent, not mined yet",
	mined: "Mined; waiting for Aztec",
	claimable: "Ready to claim",
}

function BridgesInProgress({ pool }: { pool: PoolState }) {
	const { source, bridge, go } = useApp()
	const held = useScreenHeld()
	const open = (r: BridgeRecordView) => {
		if (bridge.machine.record?.id !== r.id) bridge.resume(r, pool.noteOf.get(r.id) ?? null)
		go("bridge")
	}
	if (pool.bridges.length === 0 && pool.consumed.length === 0) return null
	return (
		<div className="grid gap-2">
			<p className="text-cap font-bold tracking-[0.06em] text-ink-3 uppercase">Bridges in progress</p>
			{pool.bridges.map((r) => (
				<div
					key={r.id}
					data-testid="bridge-record"
					className="flex flex-wrap items-center justify-between gap-2 rounded-row border border-edge bg-glass-2 px-3 py-2.5"
				>
					<span className="grid">
						<Amount
							value={r.amount}
							decimals={source.deployment.decimals}
							symbol={source.deployment.symbol}
							qualifier="to Aztec"
						/>
						<span className="text-xs text-ink-3">{STEP_TEXT[r.step as string] ?? "In progress"}</span>
					</span>
					<ActionButton disabledReason={held} onClick={() => open(r)}>
						Open
					</ActionButton>
				</div>
			))}
			{pool.consumed.map((r) => (
				<Callout key={r.id} tone="bad" title="A bridge did not land">
					{messageOf("CONSUMED_ELSEWHERE")}
				</Callout>
			))}
		</div>
	)
}

function NoNotes() {
	return (
		<EmptyState title="No pool notes found for this account">
			Either this account has not set up a pool account yet, or it set one up under another app version, whose notes this app cannot
			read. Deposit through the pool app, or sign in with the account you used there.
		</EmptyState>
	)
}

function PoolNotes({ session }: { session: Session }) {
	const { connection, bridge } = useApp()
	const pool = usePool(session, connection?.accounts ?? [], bridge.submitting)
	if (pool.isPending) return <Callout tone="wait" busy role="status" title="Reading your pool notes…" />
	if (pool.isError)
		return (
			<Callout tone="bad" title="We could not read your pool notes" role="alert">
				<p>Check your connection, then try again.</p>
				<div className="mt-2">
					<ActionButton onClick={() => void pool.refetch()}>Try again</ActionButton>
				</div>
			</Callout>
		)
	const view = poolNotesView(pool.data.notes)
	if (view.rows.length === 0 && view.emptyCount === 0 && pool.data.bridges.length === 0) return <NoNotes />
	return (
		<div className="grid gap-3">
			<BridgesInProgress pool={pool.data} />
			<p className="text-cap font-bold tracking-[0.06em] text-ink-3 uppercase">Notes by label</p>
			<ul className="grid gap-2">
				{view.rows.map((row) => (
					<NoteItem key={row.note.commitment.toString()} row={row} pool={pool.data} />
				))}
			</ul>
			{view.emptyCount > 0 ? (
				<p className="text-xs text-ink-3">
					{view.emptyCount === 1 ? "1 empty note" : `${view.emptyCount} empty notes`} (left by bridging a whole note) not shown.
				</p>
			) : null}
		</div>
	)
}

function PoolTotal({ session }: { session: Session }) {
	const { source, connection, bridge } = useApp()
	const notes = usePool(session, connection?.accounts ?? [], bridge.submitting).data?.notes
	if (!notes) return null
	const total = poolNotesView(notes).rows.reduce((sum, r) => sum + r.note.value, 0n)
	return <Amount value={total} decimals={source.deployment.decimals} symbol={source.deployment.symbol} size="total" />
}

export function PoolPanel() {
	const { eth } = useApp()
	const session = eth.status.kind === "in" ? eth.status.session : null
	return (
		<Panel
			data-testid="pool-panel"
			title="Pool (Ethereum)"
			subtitle={session ? shortHex(session.owner) : "Your notes in the pool, by label."}
			aside={session ? <PoolTotal session={session} /> : undefined}
		>
			{session ? (
				<div className="grid gap-3">
					<PoolNotes session={session} />
					<div>
						<ActionButton onClick={eth.signOut}>Sign out</ActionButton>
					</div>
				</div>
			) : (
				<EthereumSignIn />
			)}
		</Panel>
	)
}
