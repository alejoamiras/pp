import { useState } from "react"
import { type App, useApp } from "../../app/context"
import type { AztecAddress } from "../../data/stack-types"
import { codeOf, messageOf, RECIPIENT_MESSAGE } from "../../data/errors"
import { isAztecPoint, parseAztecAddress } from "../../data/parse"
import type { AztecSendHooks, LabelBalance } from "../../data/ports"
import { bindAztecSend } from "../../data/sends"
import { ActionButton, Callout, Field, LabelChip } from "../../ui"
import { ActionShell, AmountField, assertWithinSpendCap, SpendCapNote, useAction, useAmount, useSpendCap } from "./shared"

interface Props {
	account: AztecAddress
	balance: LabelBalance
	onClose(): void
}

const submitReason = (sending: boolean, missing: string | null) => (sending ? "Sending…" : (missing ?? undefined))

/** The send bound to the connection that lists `account` at the click, or `null` with the dialog failed. */
function bound(live: App["live"], account: AztecAddress, act: ReturnType<typeof useAction>): AztecSendHooks | null {
	try {
		return bindAztecSend(live.get, account)
	} catch (err) {
		act.fail(codeOf(err) ?? "CONTEXT_CHANGED")
		return null
	}
}

/** A private transfer under the same label. The page sends one transaction at a time, so a first send to a new recipient goes alone. */
export function SendDialog({ account, balance, onClose }: Props) {
	const { aztec, tx, live } = useApp()
	const [to, setTo] = useState("")
	const typed = parseAztecAddress(to)
	const recipient = typed !== null && isAztecPoint(typed) ? typed : null
	const toError = to === "" || recipient ? undefined : typed === null ? RECIPIENT_MESSAGE : messageOf("RECIPIENT_INVALID")
	const spend = useSpendCap(account, balance)
	const amount = useAmount(spend.cap ?? balance.balance)
	const act = useAction(account)
	const send = () => {
		if (!recipient || amount.amount === null) return
		const a = { to: recipient, amount: amount.amount, label: balance.label, origin: balance.origin }
		const on = bound(live, account, act)
		if (on)
			void act.send(
				"transferPrivate",
				async (guard) => {
					await assertWithinSpendCap(aztec, account, a.label, a.amount)
					return aztec.transferPrivate(account, a, guard(on))
				},
				recipient,
			)
	}
	const missing =
		spend.blocked ?? (recipient === null ? "Enter the recipient first." : amount.amount === null ? "Enter an amount first." : null)
	return (
		<ActionShell
			title="Send privately"
			description="Pays another Aztec account from this label. The label travels with the funds."
			action="send"
			state={act.state}
			onClose={onClose}
			done="The transfer is on Aztec. The recipient sees it under the same label."
		>
			<LabelChip label={balance.label} />
			<Field label="Recipient on Aztec" value={to} onValue={setTo} error={toError} />
			<AmountField field={amount} />
			<SpendCapNote spend={spend} />
			{recipient && tx.isNewRecipient(recipient) ? (
				<Callout tone="wait" title="First send to this recipient">
					It goes alone in its own transaction. Send more once it lands.
				</Callout>
			) : null}
			<ActionButton variant="primary" disabledReason={submitReason(act.state.kind === "sending", missing)} onClick={send}>
				Send
			</ActionButton>
		</ActionShell>
	)
}

/** Moves part of a label's balance to the account's public balance, which carries no label. */
export function UnshieldDialog({ account, balance, onClose }: Props) {
	const { aztec, live } = useApp()
	const spend = useSpendCap(account, balance)
	const amount = useAmount(spend.cap ?? balance.balance)
	const act = useAction(account)
	const send = () => {
		if (amount.amount === null) return
		const a = { amount: amount.amount, label: balance.label, origin: balance.origin }
		const on = bound(live, account, act)
		if (on)
			void act.send("unshield", async (guard) => {
				await assertWithinSpendCap(aztec, account, a.label, a.amount)
				return aztec.unshield(account, a, guard(on))
			})
	}
	return (
		<ActionShell
			title="Unshield"
			description="Moves part of this label's balance to your public balance on Aztec, where it carries no label."
			action="unshield"
			state={act.state}
			onClose={onClose}
			done="Unshielded. The amount is in your public balance; withdraw it to Ethereum from there."
		>
			<LabelChip label={balance.label} />
			<AmountField field={amount} />
			<SpendCapNote spend={spend} />
			<ActionButton
				variant="primary"
				disabledReason={submitReason(
					act.state.kind === "sending",
					spend.blocked ?? (amount.amount === null ? "Enter an amount first." : null),
				)}
				onClick={send}
			>
				Unshield
			</ActionButton>
		</ActionShell>
	)
}

/** Moves public balance into a new private label, which waits for approval. */
export function ShieldDialog({ account, amount: available, onClose }: { account: AztecAddress; amount: bigint; onClose(): void }) {
	const { aztec } = useApp()
	const amount = useAmount(available)
	const act = useAction(account)
	const send = () => {
		const value = amount.amount
		if (value === null) return
		void act.send("shield", () => aztec.shield(account, value))
	}
	return (
		<ActionShell
			title="Shield"
			description="Moves public balance into a new private label. The label waits for approval before it can be sent or unshielded; it can always leave to Ethereum."
			action="shield"
			state={act.state}
			onClose={onClose}
			done="Shielded. The new label shows as awaiting approval until the allow list includes it."
		>
			<AmountField field={amount} />
			<ActionButton
				variant="primary"
				disabledReason={submitReason(act.state.kind === "sending", amount.amount === null ? "Enter an amount first." : null)}
				onClick={send}
			>
				Shield
			</ActionButton>
		</ActionShell>
	)
}
