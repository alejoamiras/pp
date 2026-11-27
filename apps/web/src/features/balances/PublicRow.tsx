import { useApp } from "../../app/context"
import { ActionButton, Amount, LabelChip } from "../../ui"
import { useActionReason } from "./reasons"

export type PublicAction = "shield" | "withdraw"

/** The public balance carries no label; `amount` is `undefined` while unread or not granted. */
export function PublicRow({ amount, onAction }: { amount: bigint | undefined; onAction(kind: PublicAction, amount: bigint): void }) {
	const { source } = useApp()
	const reasonOf = useActionReason()
	const unread = amount === undefined ? "Your public balance has not been read yet." : undefined
	const empty = amount === 0n ? "Your public balance is empty." : undefined
	return (
		<div data-testid="public-row" className="grid gap-2 rounded-row border border-edge bg-glass-2 px-3 py-2.5">
			<div className="flex flex-wrap items-center justify-between gap-2.5">
				<LabelChip label={null} />
				{amount === undefined ? (
					<span className="text-ink-3">—</span>
				) : (
					<Amount value={amount} decimals={source.deployment.decimals} symbol={source.deployment.symbol} />
				)}
			</div>
			<div className="flex flex-wrap items-start gap-1.5">
				<ActionButton
					variant="primary"
					disabledReason={reasonOf("shield") ?? unread ?? empty}
					onClick={() => onAction("shield", amount ?? 0n)}
				>
					Shield
				</ActionButton>
				<ActionButton disabledReason={reasonOf("exitPublic") ?? unread ?? empty} onClick={() => onAction("withdraw", amount ?? 0n)}>
					Withdraw to Ethereum
				</ActionButton>
			</div>
			<p className="text-xs text-ink-3">
				Shield creates a new label that waits for approval. Withdrawing from here shows no label on Ethereum.
			</p>
		</div>
	)
}
