import { useEffect, useRef, useState } from "react"
import { type Address, isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { type Live, useLive } from "../../app/live"
import type { PoolNoteView } from "../../data/stack-types"
import type { BridgeMachine } from "../../data/bridge-machine"
import { codeOf, messageOf, type UiCode } from "../../data/errors"
import { bridgeView } from "../../data/model"
import { parseAmount } from "../../data/parse"
import { ActionButton, Amount, Callout, Facts, Field, LabelChip, plainAmount, shortHex } from "../../ui"
import { FailureCallout } from "./Failure"

/** The account a bridge sends from: the local demo's dev account once chosen, else the wallet's selected one. */
const senderOf = (live: Live, demo: Address | undefined): Address | null => (live.demo && demo ? demo : live.account)

/** Why Submit is closed, first cause first; `undefined` when it is open. */
function submitBlock(
	live: Live,
	sender: Address | null,
	m: BridgeMachine,
	chainId: number,
	recipient: string | null,
	amount: bigint | null,
): string | undefined {
	if (!recipient) return "Connect your Aztec wallet first."
	if (sender === null) return messageOf("NO_SENDER")
	if (live.chainId !== chainId) return messageOf("CHAIN_MISMATCH")
	if (live.owner !== null && isAddressEqual(sender, live.owner)) return "Switch your Ethereum wallet to a separate account first."
	if (amount === null) return "Enter an amount first."
	if (m.phase === "preflight") return "Checking the recipient…"
	return m.phase === "ready" ? undefined : "Waiting for the recipient check."
}

/** Preflight runs on its own once a recipient is connected, and again after any change voids it. */
function useAutoPreflight(m: BridgeMachine, recipient: string | null, epoch: number | null) {
	const { bridge } = useApp()
	const { preflight, invalidate } = bridge
	useEffect(() => {
		if (m.step === "preparing" && m.phase === "idle" && m.failure === null && recipient && epoch !== null) preflight(recipient)
	}, [m.step, m.phase, m.failure, recipient, epoch, preflight])
	useEffect(() => {
		const b = m.binding
		if (b && (b.recipient !== recipient || b.epoch !== epoch)) invalidate()
	}, [m.binding, recipient, epoch, invalidate])
}

/** Says who signs the spend; a local-stack build may offer its dev account in place of a second wallet account. */
function SenderCheck({ now, sender }: { now: Live; sender: Address | null }) {
	const { source, live } = useApp()
	const demo = source.l1.demo
	const [refused, setRefused] = useState<UiCode | null>(null)
	const mounted = useRef(true)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	if (now.demo && demo)
		return (
			<Callout tone="neutral" role="status">
				<span data-testid="demo-sender">Local demo: signed by the dev account {demo.address}, no wallet</span>
			</Callout>
		)
	if (sender === null || now.owner === null || !isAddressEqual(sender, now.owner)) return null
	// The check answers later: a choice the owner, the account or this form no longer stands behind is dropped.
	const chooseDemo = () => {
		const at = live.get()
		const still = () => mounted.current && live.get().owner === at.owner && live.get().account === at.account
		void demo?.ready().then(
			() => still() && live.set({ demo: true }),
			(err: unknown) => still() && setRefused(codeOf(err) ?? "RPC_FAILED"),
		)
	}
	return (
		<Callout tone="attn" title="Switch to a separate Ethereum account" role="status">
			{messageOf("SENDER_IS_OWNER")} The page waits for your wallet to switch.
			{demo ? (
				<span className="mt-2 flex flex-wrap items-center gap-2">
					<ActionButton onClick={chooseDemo}>Send from the local dev account</ActionButton>
					{refused ? <span>{messageOf(refused)}</span> : null}
				</span>
			) : null}
		</Callout>
	)
}

export function BridgeForm({ note }: { note: PoolNoteView }) {
	const { bridge, live, source, connection, refusal } = useApp()
	const now = useLive(live)
	const { decimals, symbol } = source.deployment
	const m = bridge.machine
	const [text, setText] = useState(() => (bridge.subject?.amount ? plainAmount(bridge.subject.amount, decimals) : ""))
	const parsed = parseAmount(text, decimals)
	const amount = parsed !== null && parsed > 0n && parsed <= note.value ? parsed : null
	const recipient = connection?.accounts[0] ?? null
	useAutoPreflight(m, recipient, now.epoch)
	const claim = refusal("claim")
	const sender = senderOf(now, source.l1.demo?.address)
	const block = claim !== null ? messageOf(claim) : submitBlock(now, sender, m, source.deployment.chainId, recipient, amount)
	const lastNotice = bridgeView(m).log.at(-1)
	return (
		<div className="grid gap-4" data-testid="bridge-form" data-phase={m.phase}>
			<Field
				label={`Amount to bridge (${symbol})`}
				inputMode="decimal"
				value={text}
				onValue={setText}
				error={text !== "" && amount === null ? messageOf("AMOUNT_INVALID") : undefined}
				hint="What is left of the note stays in the pool under the same label."
				aside={<ActionButton onClick={() => setText(plainAmount(note.value, decimals))}>Whole note</ActionButton>}
			/>
			<SenderCheck now={now} sender={sender} />
			<Facts
				wide
				facts={[
					{ key: "label", term: "Label", value: <LabelChip label={note.label} /> },
					{
						key: "change",
						term: "Stays in the pool",
						value: <Amount value={note.value - (amount ?? 0n)} decimals={decimals} symbol={symbol} />,
					},
					{ key: "from", term: "Sent from (Ethereum)", value: sender ? shortHex(sender) : "—", mono: true },
					{ key: "to", term: "Into (Aztec)", value: recipient ? shortHex(recipient) : "—", mono: true },
				]}
			/>
			{m.failure ? (
				<FailureCallout failure={m.failure} />
			) : (
				<>
					{lastNotice ? (
						<Callout tone="attn" role="status">
							{lastNotice}
						</Callout>
					) : null}
					<ActionButton
						variant="primary"
						disabledReason={block}
						onClick={() => amount !== null && recipient && void bridge.submit(amount, recipient)}
					>
						Bridge to Aztec
					</ActionButton>
				</>
			)}
		</div>
	)
}
