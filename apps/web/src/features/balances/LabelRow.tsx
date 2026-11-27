import { useId } from "react"
import { useApp } from "../../app/context"
import type { AllowListAt } from "../../app/queries"
import { labelView } from "../../data/labels"
import type { LabelBalance } from "../../data/ports"
import { ActionButton, Amount, LabelChip, StateBadge } from "../../ui"
import { useActionReason } from "./reasons"

export type LabelAction = "send" | "unshield" | "ragequit"

const ORIGIN = { 0: "Bridged from the pool", 1: "Born on Aztec by a shield" } as const
const PUBLIC_EXIT = "Leaving this way is public: it shows the label on Ethereum."

interface Props {
	balance: LabelBalance
	allow: AllowListAt | undefined
	onAction(kind: LabelAction, balance: LabelBalance): void
	onCheckAgain(): void
}

/** One label's private balance, its allow-list state in words, and what it can do. */
export function LabelRow({ balance, allow, onAction, onCheckAgain }: Props) {
	const { source } = useApp()
	const reasonOf = useActionReason()
	const sharedId = useId()
	const state = allow ? source.allowList.state(allow.view, balance.label, balance.origin, allow.nowSec) : null
	const view = state ? labelView(balance.origin, state) : null
	const send = reasonOf("transferPrivate", view)
	const unshield = reasonOf("unshield", view)
	const shared = send !== undefined && send === unshield
	return (
		<li
			data-testid="label-row"
			data-label={balance.label.toString()}
			data-state={state ?? "reading"}
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
				<ActionButton
					disabledReason={send}
					sharedReasonId={shared ? sharedId : undefined}
					onClick={() => onAction("send", balance)}
				>
					Send privately
				</ActionButton>
				<ActionButton
					disabledReason={unshield}
					sharedReasonId={shared ? sharedId : undefined}
					onClick={() => onAction("unshield", balance)}
				>
					Unshield
				</ActionButton>
				<ActionButton tag="public" disabledReason={reasonOf("ragequit")} onClick={() => onAction("ragequit", balance)}>
					Leave to Ethereum (ragequit)
				</ActionButton>
				{view?.checkAgain ? <ActionButton onClick={onCheckAgain}>Check again</ActionButton> : null}
			</div>
			{shared ? (
				<p id={sharedId} className="text-xs text-ink-3">
					{send}
				</p>
			) : null}
			<p className="text-xs text-ink-3">
				{view && !view.can.send ? `${view.meaning} ` : ""}
				{PUBLIC_EXIT}
				{view?.can.send ? " To keep it private, Unshield, then withdraw." : ""}
			</p>
		</li>
	)
}
