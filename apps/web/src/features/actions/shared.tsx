import { type ReactNode, useState } from "react"
import { type Address, isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { messageOf, PAYEE_MESSAGES, revertCopy, type UiCode } from "../../data/errors"
import { parseAmount, parsePayee } from "../../data/parse"
import type { Sent } from "../../data/ports"
import type { TxAction } from "../../data/tx"
import { ActionButton, Callout, Field, Modal, plainAmount } from "../../ui"

export type ActionState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; code: UiCode; reason?: string } | { kind: "done" }

/** Runs one send through the page's send lock and keeps its outcome for the dialog. */
export function useAction() {
	const { tx } = useApp()
	const [state, setState] = useState<ActionState>({ kind: "idle" })
	return {
		state,
		async send(action: TxAction, call: () => Promise<Sent>, recipient?: Parameters<typeof tx.run>[2]): Promise<boolean> {
			setState({ kind: "sending" })
			const outcome = await tx.run(action, call, recipient)
			setState(
				outcome.ok
					? { kind: "done" }
					: { kind: "failed", code: outcome.code, ...(outcome.reason ? { reason: outcome.reason } : {}) },
			)
			return outcome.ok
		},
		fail: (code: UiCode) => setState({ kind: "failed", code }),
	}
}

/** A typed amount in base units, checked against `0 < amount ≤ max`; the error shows once something is typed. */
export function useAmount(max: bigint) {
	const { source } = useApp()
	const { decimals, symbol } = source.deployment
	const [text, setText] = useState("")
	const parsed = parseAmount(text, decimals)
	const amount = parsed !== null && parsed > 0n && parsed <= max ? parsed : null
	const error =
		text !== "" && amount === null ? `Enter an amount above zero and at most ${plainAmount(max, decimals)} ${symbol}.` : undefined
	return { text, setText, amount, error, max }
}

export function AmountField({ field, label = "Amount" }: { field: ReturnType<typeof useAmount>; label?: string }) {
	const { source } = useApp()
	const { decimals, symbol } = source.deployment
	return (
		<Field
			label={`${label} (${symbol})`}
			inputMode="decimal"
			value={field.text}
			onValue={field.setText}
			error={field.error}
			hint={`Up to ${plainAmount(field.max, decimals)} ${symbol}.`}
			aside={<ActionButton onClick={() => field.setText(plainAmount(field.max, decimals))}>All</ActionButton>}
		/>
	)
}

/** A payee typed by the user: strict checksum, not zero, not the portal; prefilled with the selected account. */
export function usePayee() {
	const { source, live } = useApp()
	const [text, setText] = useState(() => live.get().account ?? "")
	const parsed = parsePayee(text, source.deployment.portal)
	return {
		text,
		setText,
		payee: parsed.ok ? parsed.payee : null,
		error: text !== "" && !parsed.ok ? PAYEE_MESSAGES[parsed.reason] : undefined,
	}
}

export function PayeeField({ field }: { field: ReturnType<typeof usePayee> }) {
	return (
		<Field
			label="Payee on Ethereum"
			value={field.text}
			onValue={field.setText}
			error={field.error}
			hint="The Ethereum address that receives the funds when the exit is collected."
		/>
	)
}

/** Warns, never refuses: paying the pool owner ties the exit to that account on Ethereum. */
export function OwnerWarning({ payee }: { payee: Address }) {
	const { live } = useApp()
	const { owner } = useLive(live)
	if (!owner || !isAddressEqual(owner, payee)) return null
	return (
		<Callout tone="attn" title="This payee is your pool owner's address">
			The exit will be linked to that account on Ethereum. Use another address you control to keep them apart.
		</Callout>
	)
}

/** The page's sentence for a listed revert reason; an unlisted one shows nothing. */
export function RevertLine({ reason }: { reason: string | undefined }) {
	const copy = revertCopy(reason)
	return copy === null ? null : <p className="mt-1">{copy}</p>
}

interface ShellProps {
	title: string
	description: string
	action: string
	state: ActionState
	onClose(): void
	/** What happened, in the page's words, after a success. */
	done: string
	children: ReactNode
}

/** The dialog frame every action shares: its form, then the outcome with what to do next. */
export function ActionShell({ title, description, action, state, onClose, done, children }: ShellProps) {
	return (
		<Modal
			open
			onOpenChange={(o) => !o && onClose()}
			title={title}
			description={description}
			data-testid="action-dialog"
			data-action={action}
			data-state={state.kind}
		>
			{state.kind === "done" ? (
				<Callout tone="ok" title="Sent" role="status">
					{done}
				</Callout>
			) : (
				children
			)}
			{state.kind === "failed" ? (
				<Callout tone="bad" title="It did not go through" role="alert">
					<p>{messageOf(state.code)}</p>
					<RevertLine reason={state.reason} />
				</Callout>
			) : null}
			{state.kind === "sending" ? (
				<Callout tone="wait" busy role="status" title="Approve the transaction in your Aztec wallet" />
			) : null}
			<div className="flex justify-end">
				<ActionButton onClick={onClose}>{state.kind === "done" ? "Close" : "Cancel"}</ActionButton>
			</div>
		</Modal>
	)
}
