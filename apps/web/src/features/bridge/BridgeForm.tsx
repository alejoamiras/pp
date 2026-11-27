import { useEffect, useState } from "react"
import { isAddressEqual } from "viem"
import { useApp } from "../../app/context"
import { type Live, useLive } from "../../app/live"
import type { PoolNoteView } from "../../data/stack-types"
import type { BridgeMachine } from "../../data/bridge-machine"
import { messageOf } from "../../data/errors"
import { bridgeView } from "../../data/model"
import { parseAmount } from "../../data/parse"
import { ActionButton, Amount, Callout, Facts, Field, LabelChip, plainAmount, shortHex } from "../../ui"
import { FailureCallout } from "./Failure"

/** Why Submit is closed, first cause first; `undefined` when it is open. */
function submitBlock(live: Live, m: BridgeMachine, chainId: number, recipient: string | null, amount: bigint | null): string | undefined {
	if (!recipient) return "Connect your Aztec wallet first."
	if (live.account === null) return messageOf("NO_SENDER")
	if (live.chainId !== chainId) return messageOf("CHAIN_MISMATCH")
	if (live.owner !== null && isAddressEqual(live.account, live.owner)) return "Switch your Ethereum wallet to a separate account first."
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

function SenderCheck({ live }: { live: Live }) {
	if (live.account === null || live.owner === null || !isAddressEqual(live.account, live.owner)) return null
	return (
		<Callout tone="attn" title="Switch to a separate Ethereum account" role="status">
			{messageOf("SENDER_IS_OWNER")} The page waits for your wallet to switch.
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
	const block = claim !== null ? messageOf(claim) : submitBlock(now, m, source.deployment.chainId, recipient, amount)
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
			<SenderCheck live={now} />
			<Facts
				wide
				facts={[
					{ key: "label", term: "Label", value: <LabelChip label={note.label} /> },
					{
						key: "change",
						term: "Stays in the pool",
						value: <Amount value={note.value - (amount ?? 0n)} decimals={decimals} symbol={symbol} />,
					},
					{ key: "from", term: "Sent from (Ethereum)", value: now.account ? shortHex(now.account) : "—", mono: true },
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
