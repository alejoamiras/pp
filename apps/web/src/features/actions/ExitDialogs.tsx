import { useState } from "react"
import type { Address } from "viem"
import { useApp } from "../../app/context"
import { useLabelNotes } from "../../app/queries"
import type { AztecAddress } from "../../data/a7"
import { ragequitChunks, singleCallAmounts } from "../../data/chunks"
import { codeOf, messageOf } from "../../data/errors"
import type { LabelBalance } from "../../data/ports"
import { ActionButton, Amount, Callout, Choices, Facts, formatAmount, LabelChip } from "../../ui"
import { ActionShell, AmountField, OwnerWarning, PayeeField, useAction, useAmount, usePayee } from "./shared"

const PUBLIC_LABEL = "Leaving to Ethereum is public: it shows this label on Ethereum, next to the payee."
const COLLECT = "The exit is on Aztec. Collect it on Ethereum from Exits once its epoch is proven."

interface ReviewProps {
	payee: Address
	amount: bigint
	label: bigint | null
	confirm: string
	busy: boolean
	onBack(): void
	onConfirm(): void
}

/** The last look before an exit: the payee in full and the amount, with the owner warning. */
function ExitReview({ payee, amount, label, confirm, busy, onBack, onConfirm }: ReviewProps) {
	const { source } = useApp()
	const { decimals, symbol } = source.deployment
	return (
		<div className="grid gap-3" data-testid="exit-review">
			<Facts
				facts={[
					{ key: "payee", term: "Payee on Ethereum", value: payee, mono: true },
					{ key: "amount", term: "Amount", value: <Amount value={amount} decimals={decimals} symbol={symbol} /> },
					{ key: "label", term: "Label", value: <LabelChip label={label} /> },
				]}
			/>
			<OwnerWarning payee={payee} />
			<div className="flex flex-wrap gap-2">
				<ActionButton onClick={onBack}>Back</ActionButton>
				<ActionButton
					variant="primary"
					tag={label === null ? undefined : "public"}
					disabledReason={busy ? "Sending…" : undefined}
					onClick={onConfirm}
				>
					{confirm}
				</ActionButton>
			</div>
		</div>
	)
}

/** The sums of the label's 1 to 8 largest notes, as choices. */
function useChunkChoices(account: AztecAddress, label: bigint) {
	const { source, aztec } = useApp()
	const { decimals, symbol } = source.deployment
	const notes = useLabelNotes(aztec, account, label)
	const choices = singleCallAmounts(notes.data ?? []).map((v, i) => ({
		key: v.toString(),
		label: `${formatAmount(v, decimals)} ${symbol}`,
		note: i === 0 ? "Your largest note" : `Your ${i + 1} largest notes`,
	}))
	return { notes, choices }
}

interface RagequitProps {
	account: AztecAddress
	balance: LabelBalance
	onClose(): void
}

/**
 * Exact chunks only, so nothing is left as change. The confirmed amount is re-derived against the
 * notes as they are right before sending, so a note set that changed under the dialog sends nothing.
 */
export function RagequitDialog({ account, balance, onClose }: RagequitProps) {
	const { aztec, addPayee } = useApp()
	const { notes, choices } = useChunkChoices(account, balance.label)
	const payee = usePayee()
	const [pick, setPick] = useState<string | null>(null)
	const [review, setReview] = useState(false)
	const act = useAction()
	const amount = pick === null ? null : BigInt(pick)
	const confirm = async () => {
		const to = payee.payee
		if (amount === null || !to) return
		try {
			if (ragequitChunks(await aztec.notesByLabel(account, balance.label), amount).length !== 1) return act.fail("NO_EXACT_CHUNKS")
		} catch (err) {
			return act.fail(codeOf(err) ?? "RPC_FAILED")
		}
		if (await act.send("ragequit", () => aztec.ragequit(account, { payee: to, label: balance.label, amount }))) addPayee(to)
	}
	const missing = amount === null ? "Pick an amount first." : !payee.payee ? "Enter a valid payee first." : undefined
	return (
		<ActionShell
			title="Leave to Ethereum (ragequit)"
			description={PUBLIC_LABEL}
			action="ragequit"
			state={act.state}
			onClose={onClose}
			done={COLLECT}
		>
			<Callout tone="attn" title="This exit is public">
				{PUBLIC_LABEL}
			</Callout>
			{review && amount !== null && payee.payee ? (
				<ExitReview
					payee={payee.payee}
					amount={amount}
					label={balance.label}
					confirm="Leave to Ethereum"
					busy={act.state.kind === "sending"}
					onBack={() => setReview(false)}
					onConfirm={() => void confirm()}
				/>
			) : (
				<>
					{notes.isError ? (
						<Callout tone="bad" title="We could not read this label's notes">
							{messageOf(codeOf(notes.error) ?? "RPC_FAILED")}
						</Callout>
					) : null}
					<Choices
						legend="Amount: whole notes only, so nothing is left as change"
						choices={choices}
						selected={pick}
						onSelect={setPick}
					/>
					<PayeeField field={payee} />
					<ActionButton variant="primary" disabledReason={missing} onClick={() => setReview(true)}>
						Review
					</ActionButton>
				</>
			)}
		</ActionShell>
	)
}

/** Leaves the public balance to Ethereum; no label is shown there. */
export function WithdrawDialog({ account, amount: available, onClose }: { account: AztecAddress; amount: bigint; onClose(): void }) {
	const { aztec, addPayee } = useApp()
	const amount = useAmount(available)
	const payee = usePayee()
	const [review, setReview] = useState(false)
	const act = useAction()
	const confirm = async () => {
		if (amount.amount === null || !payee.payee) return
		const a = { payee: payee.payee, amount: amount.amount }
		if (await act.send("exitPublic", () => aztec.exitPublic(account, a))) addPayee(a.payee)
	}
	const missing = amount.amount === null ? "Enter an amount first." : !payee.payee ? "Enter a valid payee first." : undefined
	return (
		<ActionShell
			title="Withdraw to Ethereum"
			description="Leaves your public balance to Ethereum. It carries no label, so none is shown there."
			action="withdraw"
			state={act.state}
			onClose={onClose}
			done={COLLECT}
		>
			{review && amount.amount !== null && payee.payee ? (
				<ExitReview
					payee={payee.payee}
					amount={amount.amount}
					label={null}
					confirm="Withdraw to Ethereum"
					busy={act.state.kind === "sending"}
					onBack={() => setReview(false)}
					onConfirm={() => void confirm()}
				/>
			) : (
				<>
					<AmountField field={amount} />
					<PayeeField field={payee} />
					<ActionButton variant="primary" disabledReason={missing} onClick={() => setReview(true)}>
						Review
					</ActionButton>
				</>
			)}
		</ActionShell>
	)
}
