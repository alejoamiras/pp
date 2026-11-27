import { useState } from "react"
import type { Address, Hash } from "viem"
import { type CollectFailure, useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { exitKey, useExits } from "../../app/queries"
import type { ExitStatus } from "../../data/stack-types"
import { BridgeFailure, codeOf, isUserRejection, messageOf, PAYEE_MESSAGES, type UiCode } from "../../data/errors"
import { parsePayee } from "../../data/parse"
import type { ExitView } from "../../data/ports"
import { bindL1Send } from "../../data/sends"
import { ActionButton, Amount, Callout, EmptyState, Field, LabelChip, Panel, StateBadge, shortHex, type Tone } from "../../ui"
import { type CollectFrom, CollectReview, sameAddress } from "./CollectReview"

const STATUS: Record<ExitStatus, { text: string; tone: Tone; note: string }> = {
	proving: {
		text: "Waiting for the epoch proof",
		tone: "wait",
		note: "The exit is on Aztec. It can be collected once its epoch is proven; on a local chain that can be the next block.",
	},
	ready: { text: "Ready to collect", tone: "attn", note: "Collecting sends one Ethereum transaction from your selected account." },
	settled: { text: "Collected", tone: "ok", note: "Paid out on Ethereum." },
}

type Failed = CollectFailure
type Collect = { kind: "idle" } | { kind: "collecting" } | ({ kind: "failed" } & Failed)

/** The Ethereum transaction a coded failure names, read as untrusted. */
const hashOf = (err: unknown): Hash | undefined => {
	const h = typeof err === "object" && err !== null ? (err as { l1TxHash?: unknown }).l1TxHash : undefined
	return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as Hash) : undefined
}

function failureOf(err: unknown, refused: "owner" | "context" | null): Failed {
	if (refused === "owner") return { code: "SENDER_IS_OWNER" }
	if (refused === "context") return { code: "CONTEXT_CHANGED" }
	if (isUserRejection(err)) return { code: "WALLET_REJECTED" }
	const txHash = hashOf(err)
	return { code: codeOf(err) ?? "RPC_FAILED", ...(txHash ? { txHash } : {}) }
}

function useCollect(view: ExitView) {
	const { source, live, collecting, refresh } = useApp()
	const key = exitKey(view)
	const collect = async (from: CollectFrom) => {
		const bound = bindL1Send(live.context, from.sender, from.chainId, from.demo)
		let ownerRefused = false
		// The owner may have signed in since the review: its address goes only with the user's yes to it.
		const handoff = () => {
			if (!from.asOwner && sameAddress(live.context().owner, from.sender)) {
				ownerRefused = true
				throw new BridgeFailure("SENDER_IS_OWNER")
			}
			bound.handoff()
		}
		await collecting.run(key, async () => {
			try {
				await source.exits.settle(view.ticket, { sender: from.sender, demo: from.demo }, { handoff })
				return undefined
			} catch (err) {
				return failureOf(err, ownerRefused ? "owner" : bound.refused() ? "context" : null)
			} finally {
				refresh()
			}
		})
	}
	const failed = collecting.failure(key)
	const state: Collect = collecting.has(key) ? { kind: "collecting" } : failed ? { kind: "failed", ...failed } : { kind: "idle" }
	return { state, collect }
}

const REFRESH_FIRST =
	"Refresh before collecting again: an exit pays out once, so a second collect fails but still costs gas, and sent from another account it also shows that account next to the payee in public."

/** Where the page's sentence for a code speaks of a bridge note, a collect says what it means for an exit. */
const COLLECT_MESSAGES: Partial<Record<UiCode, string>> = {
	UNCERTAIN: `This page could not confirm whether your collect went out. ${REFRESH_FIRST}`,
	UNKNOWN: `Something went wrong while collecting, and the collect may have gone out. ${REFRESH_FIRST}`,
	REVERTED:
		"The collect reverted on Ethereum and paid nothing. Refresh: if another payer collected this exit first, it shows as Collected.",
	SENDER_IS_OWNER: "Your pool owner signed in with the sending account before the collect went out, so nothing was sent.",
}

/** Outcomes where the collect may be on Ethereum, as is any other one that names a transaction but a revert. */
const COLLECT_UNCONFIRMED: ReadonlySet<UiCode> = new Set(["UNCERTAIN", "UNKNOWN"])

const unconfirmed = (f: Failed): boolean => f.code !== "REVERTED" && (COLLECT_UNCONFIRMED.has(f.code) || f.txHash !== undefined)

const DEMO_COLLECT_NOTE = "Collecting sends one Ethereum transaction from the local demo's dev account, no wallet."

function CollectFailed({ failed }: { failed: Failed }) {
	return (
		<Callout tone="bad" title={unconfirmed(failed) ? "Not confirmed" : "Not collected"} role="alert">
			{COLLECT_MESSAGES[failed.code] ?? messageOf(failed.code)}
			{failed.txHash ? (
				<span className="mt-1 block font-mono" title={failed.txHash}>
					Transaction {shortHex(failed.txHash)}
				</span>
			) : null}
		</Callout>
	)
}

function ExitRow({ view }: { view: ExitView }) {
	const { source, live } = useApp()
	const { state, collect } = useCollect(view)
	const [reviewing, setReviewing] = useState(false)
	const s = STATUS[view.status]
	const fromDemo = useLive(live).demo && source.l1.demo !== undefined
	const note = view.status === "ready" && fromDemo ? DEMO_COLLECT_NOTE : s.note
	const { ticket } = view
	return (
		<li
			data-testid="exit-row"
			data-key={exitKey(view)}
			data-status={view.status}
			className="grid gap-2 rounded-row border border-edge bg-glass-2 px-3 py-2.5"
		>
			<div className="flex flex-wrap items-center justify-between gap-2.5">
				<span className="flex flex-wrap items-center gap-2">
					<span className="font-semibold">
						{ticket.kind === "ragequit" ? "Leave to Ethereum (ragequit)" : "Withdraw to Ethereum"}
					</span>
					<LabelChip label={ticket.kind === "ragequit" ? ticket.label : null} />
				</span>
				<Amount value={ticket.amount} decimals={source.deployment.decimals} symbol={source.deployment.symbol} />
			</div>
			<div className="flex flex-wrap items-center gap-2 text-meta text-ink-2">
				<StateBadge tone={s.tone}>{s.text}</StateBadge>
				<span className="font-mono" title={ticket.payee}>
					to {shortHex(ticket.payee)}
				</span>
			</div>
			<p className="text-xs text-ink-3">{note}</p>
			{view.status === "ready" ? (
				<ActionButton
					variant="primary"
					disabledReason={state.kind === "collecting" ? "Collecting…" : undefined}
					onClick={() => setReviewing(true)}
				>
					Collect on Ethereum
				</ActionButton>
			) : null}
			{reviewing && view.status === "ready" ? (
				<CollectReview
					view={view}
					onClose={() => setReviewing(false)}
					onConfirm={(from) => {
						setReviewing(false)
						void collect(from)
					}}
				/>
			) : null}
			{/* A failure read before the exit was settled says nothing once the chain shows it paid. */}
			{state.kind === "failed" && view.status !== "settled" ? <CollectFailed failed={state} /> : null}
		</li>
	)
}

function PayeeLookup({ onAdd }: { onAdd(p: Address): void }) {
	const { source } = useApp()
	const [text, setText] = useState("")
	const parsed = parsePayee(text, source.deployment.portal)
	return (
		<div className="grid gap-2">
			<Field
				label="Look up exits for another payee"
				value={text}
				onValue={setText}
				error={text !== "" && !parsed.ok ? PAYEE_MESSAGES[parsed.reason] : undefined}
				aside={
					<ActionButton
						disabledReason={parsed.ok ? undefined : "Enter a payee first."}
						onClick={() => parsed.ok && onAdd(parsed.payee)}
					>
						Look up
					</ActionButton>
				}
			/>
		</div>
	)
}

/** Exits are read from the chain for each payee: the pool owner, the selected account and any payee used or looked up here. */
export function ExitsScreen() {
	const { source, live, payees, addPayee } = useApp()
	const { owner, account } = useLive(live)
	const all = [...new Set([owner, account, ...payees].filter((p): p is Address => p !== null))]
	const exits = useExits(source, all)
	return (
		<Panel
			data-testid="exits-screen"
			title="Exits"
			subtitle="Leaving to Ethereum takes two steps: the exit on Aztec, then collecting it on Ethereum."
		>
			<div className="grid gap-3">
				{all.length === 0 ? (
					<EmptyState title="No payee to look up">Connect your Ethereum wallet, or enter a payee below.</EmptyState>
				) : null}
				{exits.isError ? (
					<Callout tone="bad" title="We could not read your exits" role="alert">
						<p>Check your connection, then try again.</p>
						<div className="mt-2">
							<ActionButton onClick={() => void exits.refetch()}>Try again</ActionButton>
						</div>
					</Callout>
				) : null}
				{exits.data?.length === 0 ? (
					<EmptyState title="No exits yet">Exits you start from a label or your public balance show here.</EmptyState>
				) : null}
				{exits.data && exits.data.length > 0 ? (
					<ul className="grid gap-2">
						{exits.data.map((v) => (
							<ExitRow key={exitKey(v)} view={v} />
						))}
					</ul>
				) : null}
				<div className="flex flex-wrap gap-2">
					<ActionButton onClick={() => void exits.refetch()}>Refresh</ActionButton>
				</div>
				<PayeeLookup onAdd={addPayee} />
			</div>
		</Panel>
	)
}
