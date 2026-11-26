import { useApp } from "../../app/context"
import { usePool } from "../../app/queries"
import type { BridgeRecordView, PoolNoteView } from "../../data/a7"
import { messageOf } from "../../data/errors"
import { type NoteRow, poolNotesView } from "../../data/model"
import type { Session } from "../../data/ports"
import type { PoolState } from "../../data/reconcile"
import { ActionButton, Amount, Callout, EmptyState, LabelChip, Panel, StateBadge, shortHex } from "../../ui"
import { EthereumSignIn } from "../connect/EthereumSignIn"

const BUSY = new Set(["starting", "proving", "sending", "preflight"])

/** Why this note's bridge cannot start, or `undefined`. */
function useBridgeBlock(): string | undefined {
	const { connection, refusal, bridge } = useApp()
	if (!connection) return "Connect your Aztec wallet first: the bridge pays into its account."
	if (refusal("claim") !== null) return "Your Aztec wallet did not allow claiming. Connect again and allow it."
	if (bridge.subject && BUSY.has(bridge.machine.phase)) return "Finish the bridge in progress first."
	return undefined
}

function NoteItem({ row, inFlight }: { row: NoteRow; inFlight: boolean }) {
	const { source, bridge, go, refresh } = useApp()
	const block = useBridgeBlock()
	const { note } = row
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
				<Callout tone="attn" title="A bridge from this note may be in flight" role="status">
					<p>We can't see its Ethereum transaction yet, so this note cannot be bridged again until we can.</p>
					<div className="mt-2">
						<ActionButton onClick={refresh}>Check again</ActionButton>
					</div>
				</Callout>
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
					<ActionButton onClick={() => open(r)}>Open</ActionButton>
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
	const pool = usePool(session)
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
					<NoteItem key={row.note.commitment.toString()} row={row} inFlight={pool.data.inFlight.has(row.note.commitment)} />
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
	const { source } = useApp()
	const notes = usePool(session).data?.notes
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
