import { useState } from "react"
import { type Address, type Hash, isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { messageOf } from "../../data/errors"
import type { ExitView } from "../../data/ports"
import { ActionButton, Amount, Callout, Facts, Modal, shortHex } from "../../ui"

/** The sender a confirmed collect is bound to; `asOwner` is the user's explicit yes to sending from the pool owner's address. */
export interface CollectFrom {
	sender: Address
	chainId: number
	demo: boolean
	asOwner: boolean
}

export const sameAddress = (a: Address | null, b: Address | null): boolean => a !== null && b !== null && isAddressEqual(a, b)

const DEMO_NOTE = "Sent from the local demo's dev account, with no wallet prompt."

function refusal(sender: Address | null, chainOk: boolean, ownerUnaccepted: boolean): string | undefined {
	if (sender === null) return messageOf("NO_SENDER")
	if (!chainOk) return messageOf("CHAIN_MISMATCH")
	return ownerUnaccepted ? "Collect from another account, or confirm the public link first." : undefined
}

/** The payee collecting its own exit adds no link: the ticket already names it. */
function LinkNote({ sender, payee, label }: { sender: Address; payee: Address; label: boolean }) {
	if (isAddressEqual(sender, payee)) return null
	return (
		<Callout tone="attn" title="This links two addresses in public">
			The collect is a transaction from {sender} that pays {payee}
			{label ? " under this label" : ""}, so anyone can see them together on Ethereum.
		</Callout>
	)
}

function OwnerBlock(p: { sender: Address; payee: Address; label: boolean; accepted: boolean; onAccept(yes: boolean): void }) {
	return (
		<Callout tone="bad" title="This is your pool owner's address">
			<p>
				Collecting from it links the pool owner to this payee{p.label ? " and this label" : ""} on Ethereum, publicly and
				permanently. Collect from another funded Ethereum account instead.
			</p>
			<label className="mt-2 flex items-start gap-2">
				<input
					type="checkbox"
					data-testid="collect-owner-override"
					className="mt-1"
					checked={p.accepted}
					onChange={(e) => p.onAccept(e.target.checked)}
				/>
				<span>
					Collect from the pool owner's address {p.sender} anyway. I understand this links it to {p.payee} in public, and that the
					link is permanent.
				</span>
			</label>
		</Callout>
	)
}

/**
 * The collect's sender and payee, read live, before anything is sent. A sender other than the payee
 * is said to be linked to it; the signed-in pool owner's address is refused unless the user accepts
 * that link for that exact address.
 */
export function CollectReview({
	view,
	earlier,
	onClose,
	onConfirm,
}: {
	view: ExitView
	/** An earlier collect's transaction that may still pay this exit out. */
	earlier: Hash | undefined
	onClose(): void
	onConfirm(from: CollectFrom): void
}) {
	const { source, live } = useApp()
	useLive(live)
	const ctx = live.context()
	const [accepted, setAccepted] = useState<Address | null>(null)
	const { ticket } = view
	const sender = ctx.account
	const isOwner = sameAddress(ctx.owner, sender)
	const asOwner = isOwner && sameAddress(accepted, sender)
	const label = ticket.kind === "ragequit"
	const reason = refusal(sender, ctx.chainId === source.deployment.chainId, isOwner && !asOwner)
	return (
		<Modal
			open
			onOpenChange={(open) => !open && onClose()}
			title="Collect on Ethereum"
			description="One Ethereum transaction pays this exit out. Check who sends it before you confirm."
			data-testid="collect-review"
		>
			<Facts
				facts={[
					{ key: "from", term: "Sent from", value: sender ?? "No Ethereum account", mono: sender !== null },
					{ key: "payee", term: "Pays", value: ticket.payee, mono: true },
					{
						key: "amount",
						term: "Amount",
						value: <Amount value={ticket.amount} decimals={source.deployment.decimals} symbol={source.deployment.symbol} />,
					},
				]}
			/>
			{ctx.demo && source.l1.demo ? <p className="text-xs text-ink-3">{DEMO_NOTE}</p> : null}
			{earlier ? (
				<Callout tone="attn" title="An earlier collect may still pay this out">
					Transaction <span className="font-mono">{shortHex(earlier)}</span> has not been read as paid or failed. Refresh first:
					if it lands, this collect fails but still costs gas.
				</Callout>
			) : null}
			{sender === null ? null : isOwner ? (
				<OwnerBlock
					sender={sender}
					payee={ticket.payee}
					label={label}
					accepted={asOwner}
					onAccept={(yes) => setAccepted(yes ? sender : null)}
				/>
			) : (
				<LinkNote sender={sender} payee={ticket.payee} label={label} />
			)}
			<div className="flex flex-wrap gap-2">
				<ActionButton onClick={onClose}>Back</ActionButton>
				<ActionButton
					variant="primary"
					disabledReason={reason}
					onClick={() =>
						sender !== null && ctx.chainId !== null && onConfirm({ sender, chainId: ctx.chainId, demo: ctx.demo, asOwner })
					}
				>
					Collect
				</ActionButton>
			</div>
		</Modal>
	)
}
