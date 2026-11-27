import { useEffect, useId, useState } from "react"
import { useApp } from "../../app/context"
import { useLabelCheck } from "../../app/queries"
import { AllowListError, HELD_LIST_CODES, messageOf } from "../../data/errors"
import { labelView, listFailureView } from "../../data/labels"
import type { AllowListView, LabelBalance } from "../../data/ports"
import { ActionButton, Amount, LabelChip, StateBadge } from "../../ui"
import { useActionReason } from "./reasons"

export type LabelAction = "send" | "unshield" | "exit" | "ragequit"

const ORIGIN = { 0: "Bridged from the pool", 1: "Born on Aztec by a shield" } as const
const PUBLIC_EXIT = "Ragequit is public: it shows the label on Ethereum."

interface Props {
	balance: LabelBalance
	allow: AllowListView | undefined
	onAction(kind: LabelAction, balance: LabelBalance): void
	onCheckAgain(): void
}

/** Opens once the failed list's backoff has passed, on the page's timer. */
function CheckAgain({ waitMs, onClick }: { waitMs: number; onClick(): void }) {
	const { source } = useApp()
	const [ready, setReady] = useState(waitMs === 0)
	useEffect(() => {
		setReady(waitMs === 0)
		if (waitMs === 0) return
		const stop = new AbortController()
		void source.timer.sleep(waitMs, stop.signal).then((elapsed) => elapsed && setReady(true))
		return () => stop.abort()
	}, [source, waitMs])
	return (
		<ActionButton disabledReason={ready ? undefined : "Wait a moment before checking again"} onClick={onClick}>
			Check again
		</ActionButton>
	)
}

/**
 * The label's state under `allow`, or why its list could not be checked; neither while the check runs.
 * A held failure goes before an earlier state: the adapter refuses every spend of that list until a
 * Check again, so the row must not offer one. A transient failure keeps the earlier state.
 */
function useLabelState(allow: AllowListView | undefined, balance: LabelBalance) {
	const { source } = useApp()
	const check = useLabelCheck(source, allow, balance.label, balance.origin)
	const failure = check.error instanceof AllowListError ? check.error : check.isError ? new AllowListError("LIST_UNAVAILABLE") : null
	const state = failure && HELD_LIST_CODES.has(failure.code) ? null : (check.data?.state ?? null)
	const view = state ? labelView(balance.origin, state) : failure ? listFailureView(failure.code) : null
	return { state, failure, view }
}

/** One label's private balance, its allow-list state in words, and what it can do. */
export function LabelRow({ balance, allow, onAction, onCheckAgain }: Props) {
	const { source, refusal } = useApp()
	const reasonOf = useActionReason()
	const sharedId = useId()
	const { state, failure, view } = useLabelState(allow, balance)
	const send = reasonOf("transferPrivate", view)
	const unshield = reasonOf("unshield", view)
	// The withdrawal reads the label's notes for its cap.
	const notes = refusal("notes")
	const exit = (notes === null ? undefined : messageOf(notes)) ?? reasonOf("exitPrivate", view)
	const shared = send !== undefined && send === unshield
	const sharedWith = (reason: string | undefined) => (shared && reason === send ? sharedId : undefined)
	return (
		<li
			data-testid="label-row"
			data-label={balance.label.toString()}
			data-state={state ?? failure?.code ?? "reading"}
			className="grid gap-2 rounded-row border border-edge bg-glass-2 px-3 py-2.5"
		>
			<div className="flex flex-wrap items-center justify-between gap-2.5">
				<LabelChip label={balance.label} />
				<Amount value={balance.balance} decimals={source.deployment.decimals} symbol={source.deployment.symbol} />
			</div>
			<div className="flex flex-wrap items-center gap-2 text-meta text-ink-2">
				{view ? (
					<StateBadge tone={view.tone}>{view.text}</StateBadge>
				) : (
					<StateBadge tone="neutral">Reading the allow list</StateBadge>
				)}
				<span>{ORIGIN[balance.origin]}</span>
			</div>
			<div className="flex flex-wrap items-start gap-1.5">
				<ActionButton disabledReason={send} sharedReasonId={sharedWith(send)} onClick={() => onAction("send", balance)}>
					Send privately
				</ActionButton>
				<ActionButton disabledReason={unshield} sharedReasonId={sharedWith(unshield)} onClick={() => onAction("unshield", balance)}>
					Unshield
				</ActionButton>
				<ActionButton disabledReason={exit} sharedReasonId={sharedWith(exit)} onClick={() => onAction("exit", balance)}>
					Withdraw to Ethereum
				</ActionButton>
				<ActionButton tag="public" disabledReason={reasonOf("ragequit")} onClick={() => onAction("ragequit", balance)}>
					Leave to Ethereum (ragequit)
				</ActionButton>
				{view?.checkAgain ? <CheckAgain waitMs={failure?.retryInMs ?? 0} onClick={onCheckAgain} /> : null}
			</div>
			{shared ? (
				<p id={sharedId} className="text-xs text-ink-3">
					{send}
				</p>
			) : null}
			<p className="text-xs text-ink-3">
				{view && !view.can.send ? `${view.meaning} ` : ""}
				{PUBLIC_EXIT}
				{view?.can.unshield ? " Withdraw to Ethereum does not show the label." : ""}
			</p>
		</li>
	)
}
