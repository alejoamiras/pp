import { useState } from "react"
import type { Address } from "viem"
import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { exitKey, useExits } from "../../app/queries"
import type { ExitStatus } from "../../data/stack-types"
import { codeOf, isUserRejection, messageOf, PAYEE_MESSAGES, type UiCode } from "../../data/errors"
import { parsePayee } from "../../data/parse"
import type { ExitView } from "../../data/ports"
import { bindL1Send } from "../../data/sends"
import { ActionButton, Amount, Callout, EmptyState, Field, LabelChip, Panel, StateBadge, shortHex, type Tone } from "../../ui"

const STATUS: Record<ExitStatus, { text: string; tone: Tone; note: string }> = {
	proving: {
		text: "Waiting for the epoch proof",
		tone: "wait",
		note: "The exit is on Aztec. It can be collected once its epoch is proven; on a local chain that can be the next block.",
	},
	ready: { text: "Ready to collect", tone: "attn", note: "Collecting sends one Ethereum transaction from your selected account." },
	settled: { text: "Collected", tone: "ok", note: "Paid out on Ethereum." },
}

type Collect = { kind: "idle" } | { kind: "collecting" } | { kind: "failed"; code: UiCode }

function useCollect(view: ExitView) {
	const { source, live, refresh } = useApp()
	const [state, setState] = useState<Collect>({ kind: "idle" })
	const collect = async () => {
		// The context's account is the local demo's dev account while the page has chosen it, as for a bridge.
		const { account, chainId, demo } = live.context()
		if (account === null) return setState({ kind: "failed", code: "NO_SENDER" })
		if (chainId !== source.deployment.chainId) return setState({ kind: "failed", code: "CHAIN_MISMATCH" })
		const on = bindL1Send(live.context, account, chainId)
		setState({ kind: "collecting" })
		try {
			await source.exits.settle(view.ticket, { sender: account, demo }, on)
			setState({ kind: "idle" })
		} catch (err) {
			const code = on.refused() ? "CONTEXT_CHANGED" : isUserRejection(err) ? "WALLET_REJECTED" : (codeOf(err) ?? "RPC_FAILED")
			setState({ kind: "failed", code })
		} finally {
			refresh()
		}
	}
	return { state, collect }
}

const DEMO_COLLECT_NOTE = "Collecting sends one Ethereum transaction from the local demo's dev account, no wallet."

function ExitRow({ view }: { view: ExitView }) {
	const { source, live } = useApp()
	const { state, collect } = useCollect(view)
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
					onClick={() => void collect()}
				>
					Collect on Ethereum
				</ActionButton>
			) : null}
			{state.kind === "failed" ? (
				<Callout tone="bad" title="Not collected" role="alert">
					{messageOf(state.code)}
				</Callout>
			) : null}
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
