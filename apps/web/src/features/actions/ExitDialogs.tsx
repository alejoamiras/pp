import { useState } from "react"
import type { Address } from "viem"
import { type App, useApp } from "../../app/context"
import { useLabelNotes } from "../../app/queries"
import type { AztecAddress } from "../../data/stack-types"
import { ragequitChunks, singleCallAmounts } from "../../data/chunks"
import { BridgeFailure, codeOf, messageOf } from "../../data/errors"
import type { AztecSendHooks, LabelBalance } from "../../data/ports"
import { bindAztecSend } from "../../data/sends"
import { ActionButton, Callout, Choices, Facts, formatAmount, LabelChip, plainAmount } from "../../ui"
import {
	type ActionState,
	ActionShell,
	AmountField,
	type Guard,
	OwnerWarning,
	PayeeField,
	SpendCapNote,
	useAction,
	useAmount,
	usePayee,
	useSpendCap,
} from "./shared"

const PUBLIC_LABEL = "Leaving to Ethereum is public: it shows this label on Ethereum, next to the payee."
const COLLECT = "The exit is on Aztec. Collect it on Ethereum from Exits once its epoch is proven."
const COLLECT_PAYER =
	"Collecting it on Ethereum later takes a funded Ethereum account to pay the gas. Not your pool owner's: collecting from it links the owner to this payee in public."
const BALANCE_PUBLIC = "Public: your Aztec account, the payee and the amount."
const SCREENED_PUBLIC = "Public: your Aztec account, the payee and the amount. Not shown: the label."

interface ReviewProps {
	payee: Address
	amount: bigint
	/** The label the amount leaves from, `null` for the public balance. */
	label: bigint | null
	/** Whether the exit shows the label on Ethereum, which tags the confirm public. */
	labelPublic: boolean
	/** What the exit makes public, when the dialog does not already say it. */
	exposes?: string
	confirm: string
	state: ActionState
	onBack(): void
	onConfirm(): void
}

/** The confirm step: the amount in every decimal it has, since what is sent is irreversible. */
function ExitReview({ payee, amount, label, labelPublic, exposes, confirm, state, onBack, onConfirm }: ReviewProps) {
	const { source } = useApp()
	const { decimals, symbol } = source.deployment
	const sending = state.kind === "sending"
	// Once the wallet holds the request, an editable form would show details other than the ones it is asking about.
	const held = sending && state.handedOff
	return (
		<div className="grid gap-3" data-testid="exit-review">
			<Facts
				facts={[
					{ key: "payee", term: "Payee on Ethereum", value: payee, mono: true },
					{ key: "amount", term: "Amount", value: `${plainAmount(amount, decimals)} ${symbol}` },
					{ key: "label", term: "Label", value: <LabelChip label={label} /> },
				]}
			/>
			{exposes ? (
				<p className="text-sm text-ink-2" data-testid="exit-public">
					{exposes}
				</p>
			) : null}
			<OwnerWarning payee={payee} />
			<p className="text-xs text-ink-3" data-testid="exit-collect-payer">
				{COLLECT_PAYER}
			</p>
			<div className="flex flex-wrap gap-2">
				<ActionButton disabledReason={held ? "Your wallet has this request; answer it there." : undefined} onClick={onBack}>
					Back
				</ActionButton>
				<ActionButton
					variant="primary"
					tag={labelPublic ? "public" : undefined}
					disabledReason={sending ? "Sending…" : undefined}
					onClick={onConfirm}
				>
					{confirm}
				</ActionButton>
			</div>
		</div>
	)
}

/** What a review shows and its confirm sends, fixed at Review: a refetch of the cap under it changes neither. */
interface Reviewed {
	payee: Address
	amount: bigint
}

const reviewed = (payee: Address | null, amount: bigint | null): Reviewed | null => (payee && amount !== null ? { payee, amount } : null)

/** `on` behind the attempt's guard, with the payee joining Exits at the handoff: an exit whose outcome is never read must still be listed. */
function listedAt(guard: Guard, on: AztecSendHooks, list: () => void): AztecSendHooks {
	const g = guard(on)
	return {
		...g,
		handoff() {
			g.handoff()
			list()
		},
	}
}

/** The send bound to the connection that lists `account` at the click, or `null` with the dialog failed. */
function bound(live: App["live"], account: AztecAddress, act: ReturnType<typeof useAction>): AztecSendHooks | null {
	try {
		return bindAztecSend(live.get, account)
	} catch (err) {
		act.fail(codeOf(err) ?? "CONTEXT_CHANGED")
		return null
	}
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

interface LabelProps {
	account: AztecAddress
	balance: LabelBalance
	onClose(): void
}

/**
 * Exact chunks only, so nothing is left as change. The confirmed amount is re-derived against the
 * notes as they are right before sending, so a note set that changed under the dialog sends nothing,
 * and the send stays bound to the Aztec connection the confirm was made in.
 */
export function RagequitDialog({ account, balance, onClose }: LabelProps) {
	const { aztec, live, addPayee } = useApp()
	const { notes, choices } = useChunkChoices(account, balance.label)
	const payee = usePayee()
	const [pick, setPick] = useState<string | null>(null)
	const [review, setReview] = useState<Reviewed | null>(null)
	const act = useAction(account)
	const amount = pick === null ? null : BigInt(pick)
	const confirm = async ({ payee: to, amount: value }: Reviewed) => {
		const on = bound(live, account, act)
		if (!on) return
		// The note read runs under the send lock, so a second click or a Back meanwhile sends nothing more.
		await act.send("ragequit", async (guard) => {
			if (ragequitChunks(await aztec.notesByLabel(account, balance.label), value).length !== 1)
				throw new BridgeFailure("NO_EXACT_CHUNKS")
			return aztec.ragequit(
				account,
				{ payee: to, label: balance.label, amount: value },
				listedAt(guard, on, () => addPayee(to)),
			)
		})
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
			{review ? (
				<ExitReview
					payee={review.payee}
					amount={review.amount}
					label={balance.label}
					labelPublic
					confirm="Leave to Ethereum"
					state={act.state}
					onBack={() => {
						act.stop()
						setReview(null)
					}}
					onConfirm={() => void confirm(review)}
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
					<ActionButton variant="primary" disabledReason={missing} onClick={() => setReview(reviewed(payee.payee, amount))}>
						Review
					</ActionButton>
				</>
			)}
		</ActionShell>
	)
}

/** Leaves the public balance to Ethereum; no label is shown there. The send stays bound to the Aztec connection the confirm was made in. */
export function WithdrawDialog({ account, amount: available, onClose }: { account: AztecAddress; amount: bigint; onClose(): void }) {
	const { aztec, live, addPayee } = useApp()
	const amount = useAmount(available)
	const payee = usePayee()
	const [review, setReview] = useState<Reviewed | null>(null)
	const act = useAction(account)
	const confirm = async (a: Reviewed) => {
		const on = bound(live, account, act)
		if (!on) return
		await act.send("exitPublic", (guard) =>
			aztec.exitPublic(
				account,
				a,
				listedAt(guard, on, () => addPayee(a.payee)),
			),
		)
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
			{review ? (
				<ExitReview
					payee={review.payee}
					amount={review.amount}
					label={null}
					labelPublic={false}
					exposes={BALANCE_PUBLIC}
					confirm="Withdraw to Ethereum"
					state={act.state}
					onBack={() => {
						act.stop()
						setReview(null)
					}}
					onConfirm={() => void confirm(review)}
				/>
			) : (
				<>
					<AmountField field={amount} />
					<PayeeField field={payee} />
					<ActionButton
						variant="primary"
						disabledReason={missing}
						onClick={() => setReview(reviewed(payee.payee, amount.amount))}
					>
						Review
					</ActionButton>
				</>
			)}
		</ActionShell>
	)
}

/**
 * Leaves part of a label's balance to Ethereum in one transaction that unshields it and withdraws it,
 * so Ethereum is never shown the label. The amount is capped at what the label's 8 largest notes hold,
 * and the send stays bound to the Aztec connection the confirm was made in.
 */
export function LabelExitDialog({ account, balance, onClose }: LabelProps) {
	const { aztec, live, addPayee } = useApp()
	const spend = useSpendCap(account, balance)
	const amount = useAmount(spend.max)
	const payee = usePayee()
	const [review, setReview] = useState<Reviewed | null>(null)
	const act = useAction(account)
	const confirm = async ({ payee: to, amount: value }: Reviewed) => {
		const a = { payee: to, amount: value, label: balance.label, origin: balance.origin }
		const on = bound(live, account, act)
		if (!on) return
		// The port reads the notes again after the allow-list check.
		await act.send("unshieldAndExit", (guard) =>
			aztec.unshieldAndExit(
				account,
				a,
				listedAt(guard, on, () => addPayee(to)),
			),
		)
	}
	const missing =
		spend.blocked ?? (amount.amount === null ? "Enter an amount first." : !payee.payee ? "Enter a valid payee first." : undefined)
	return (
		<ActionShell
			title="Withdraw to Ethereum"
			description="Unshields part of this label's balance and withdraws it to Ethereum in one transaction."
			action="exit"
			state={act.state}
			onClose={onClose}
			done={COLLECT}
		>
			{review ? (
				<ExitReview
					payee={review.payee}
					amount={review.amount}
					label={balance.label}
					labelPublic={false}
					exposes={SCREENED_PUBLIC}
					confirm="Withdraw to Ethereum"
					state={act.state}
					onBack={() => {
						act.stop()
						setReview(null)
					}}
					onConfirm={() => void confirm(review)}
				/>
			) : (
				<>
					<LabelChip label={balance.label} />
					<AmountField field={amount} />
					<SpendCapNote spend={spend} />
					<PayeeField field={payee} />
					<ActionButton
						variant="primary"
						disabledReason={missing ?? undefined}
						onClick={() => setReview(reviewed(payee.payee, amount.amount))}
					>
						Review
					</ActionButton>
				</>
			)}
		</ActionShell>
	)
}
