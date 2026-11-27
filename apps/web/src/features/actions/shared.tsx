import { type ReactNode, useEffect, useRef, useState } from "react"
import { type Address, type Hex, isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { useLabelNotes } from "../../app/queries"
import { spendCap } from "../../data/chunks"
import { BridgeFailure, codeOf, messageOf, PAYEE_MESSAGES, revertCopy, type UiCode } from "../../data/errors"
import { parseAmount, parsePayee } from "../../data/parse"
import type { AztecSendHooks, LabelBalance, Sent } from "../../data/ports"
import type { AztecAddress } from "../../data/stack-types"
import type { TxAction, TxOutcome } from "../../data/tx"
import { ActionButton, Callout, Field, Modal, plainAmount, shortHex } from "../../ui"

/** `handedOff`: the wallet holds the request, so closing the dialog no longer stops the send. */
export type ActionState =
	| { kind: "idle" }
	| { kind: "sending"; handedOff: boolean }
	| { kind: "failed"; code: UiCode; reason?: string; txHash?: Hex }
	| { kind: "done" }

/** Wraps a send's hooks so its handoff refuses once the attempt was stopped. */
export type Guard = <H extends AztecSendHooks>(on: H) => H

/**
 * Runs one send through the page's send lock and keeps its outcome for the dialog. The lock is taken
 * at the click, before any read the send makes; Back, `stop` or closing the dialog stops the attempt,
 * and a stopped attempt's handoff refuses, so nothing reaches the wallet after it.
 */
export function useAction(from: AztecAddress) {
	const { tx } = useApp()
	const [state, setState] = useState<ActionState>({ kind: "idle" })
	const attempt = useRef(0)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			attempt.current++
		}
	}, [])
	const setFor = (n: number, s: ActionState) => {
		if (mounted.current && attempt.current === n) setState(s)
	}
	return {
		state,
		async send(action: TxAction, call: (guard: Guard) => Promise<Sent>, recipient?: AztecAddress): Promise<boolean> {
			const n = ++attempt.current
			setState({ kind: "sending", handedOff: false })
			const outcome = await tx.run(
				action,
				from,
				(handedOff) => {
					const guard: Guard = (on) => ({
						...on,
						handoff() {
							if (attempt.current !== n) throw new BridgeFailure("CONTEXT_CHANGED")
							on.handoff()
							handedOff()
							setFor(n, { kind: "sending", handedOff: true })
						},
					})
					return call(guard)
				},
				recipient,
			)
			setFor(n, outcome.ok ? { kind: "done" } : { kind: "failed", code: outcome.code, ...detailOf(outcome) })
			return outcome.ok && attempt.current === n
		},
		fail: (code: UiCode) => setState({ kind: "failed", code }),
		/** Stops the attempt in progress unless the wallet already holds it, and clears its outcome. */
		stop() {
			if (state.kind === "sending" && state.handedOff) return
			attempt.current++
			setState({ kind: "idle" })
		},
	}
}

const detailOf = (o: Extract<TxOutcome, { ok: false }>) => ({
	...(o.reason ? { reason: o.reason } : {}),
	...(o.txHash ? { txHash: o.txHash } : {}),
})

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

/**
 * The most one spend of `balance`'s label can move (`spendCap`), from the label's notes: `max` for the
 * form, never above the balance, which is read apart and can lag the notes; `cap` is null until they
 * are read, and `blocked` says why the spend waits meanwhile. The port checks again before the handoff.
 */
export function useSpendCap(account: AztecAddress, balance: LabelBalance) {
	const { aztec } = useApp()
	const notes = useLabelNotes(aztec, account, balance.label)
	const cap = notes.data ? spendCap(notes.data) : null
	const short = cap !== null && cap < balance.balance
	const blocked = notes.isError ? "We could not read this label's notes." : cap === null ? "Reading this label's notes…" : null
	return { cap, max: short && cap !== null ? cap : balance.balance, notes, blocked, short }
}

/** Says why a spend's amount stops short of the label's balance, or that its notes could not be read. */
export function SpendCapNote({ spend }: { spend: ReturnType<typeof useSpendCap> }) {
	const { source } = useApp()
	const { decimals, symbol } = source.deployment
	if (spend.notes.isError)
		return (
			<Callout tone="bad" title="We could not read this label's notes">
				{messageOf(codeOf(spend.notes.error) ?? "RPC_FAILED")}
			</Callout>
		)
	if (!spend.short || spend.cap === null) return null
	return (
		<p className="text-xs text-ink-3">
			One transaction spends at most this label's 8 largest notes: up to {plainAmount(spend.cap, decimals)} {symbol}. Move the rest in
			another transaction.
		</p>
	)
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

/** Outcomes where the transaction may be on Aztec: never titled as one that did not go through. */
const UNCONFIRMED: ReadonlySet<UiCode> = new Set(["TX_UNCONFIRMED", "TX_DROPPED", "UNKNOWN"])

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
				<Callout tone="bad" title={UNCONFIRMED.has(state.code) ? "Not confirmed" : "It did not go through"} role="alert">
					<p>{messageOf(state.code)}</p>
					{state.txHash ? <p className="font-mono text-meta">Transaction {shortHex(state.txHash)}</p> : null}
					<RevertLine reason={state.reason} />
				</Callout>
			) : null}
			{state.kind === "sending" ? (
				<Callout tone="wait" busy role="status" title="Approve the transaction in your Aztec wallet" />
			) : null}
			<div className="flex justify-end">
				<ActionButton onClick={onClose}>
					{state.kind === "done" || (state.kind === "sending" && state.handedOff) ? "Close" : "Cancel"}
				</ActionButton>
			</div>
		</Modal>
	)
}
