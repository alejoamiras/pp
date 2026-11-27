import { useApp } from "../../app/context"
import type { BridgeMachine } from "../../data/bridge-machine"
import { bridgeView } from "../../data/model"
import { ActionButton, Amount, Callout, type CrossingState, Facts, LabelChip, LabelCrossing, shortHex, Stepper } from "../../ui"
import { FailureCallout } from "./Failure"
import { NoticeLog } from "./NoticeLog"

const NOW: Record<string, { title: string; body: string }> = {
	prepared: { title: "Checking the proof against the chain", body: "Your Ethereum wallet will ask you to send the bridge." },
	submitted: { title: "Sent: waiting for the Ethereum transaction to be mined", body: "Nothing to do; this takes a block or two." },
	mined: { title: "Mined: waiting for Aztec to include the message", body: "Nothing to do; it follows Aztec's blocks (chain time)." },
	claiming: { title: "Approve the claim in your Aztec wallet", body: "It asks for one transaction; the fee is sponsored." },
}

function crossing(m: BridgeMachine): CrossingState {
	if (m.step === "claimed") return "arrived"
	return m.failure ? "stopped" : "moving"
}

/** What is happening now and whether it needs the user. */
function NowPanel({ m }: { m: BridgeMachine }) {
	const step = m.step as string
	if (m.phase === "pending")
		return (
			<Callout tone="attn" title="Aztec has not included the claim yet" role="status">
				It stays pending, and the page will not send it again. Check your Aztec wallet's activity before doing anything else.
			</Callout>
		)
	const now = NOW[step]
	if (!now) return null
	return (
		<Callout tone="wait" busy role="status" title={now.title}>
			{now.body}
		</Callout>
	)
}

/** The claim request, spelled out before the wallet asks. */
function NextYou() {
	const { bridge, source, connection } = useApp()
	const { amount, note } = bridge.subject ?? { amount: null, note: null }
	// The claim sends from the record's recipient, which can be any of the wallet's accounts.
	const into = bridge.machine.record?.recipient ?? connection?.accounts[0]
	return (
		<div className="grid gap-3">
			<Callout tone="attn" eyebrow="Next, you" title="Your Aztec wallet will ask you to approve one transaction">
				<Facts
					wide
					facts={[
						{
							key: "claim",
							term: "Claim",
							value:
								amount === null ? (
									"—"
								) : (
									<Amount value={amount} decimals={source.deployment.decimals} symbol={source.deployment.symbol} />
								),
						},
						{ key: "into", term: "Into", value: into ? shortHex(into) : "—", mono: true },
						{ key: "label", term: "Label", value: note ? <LabelChip label={note.label} /> : "—" },
						{ key: "fee", term: "Fee", value: "Sponsored" },
					]}
				/>
			</Callout>
			<ActionButton variant="primary" onClick={() => void bridge.claim()}>
				Claim on Aztec
			</ActionButton>
		</div>
	)
}

export function InFlight() {
	const { bridge, go } = useApp()
	const m = bridge.machine
	const view = bridgeView(m)
	const label = bridge.subject?.note?.label
	return (
		<div className="grid gap-4">
			{label !== undefined ? (
				<LabelCrossing
					label={label}
					state={crossing(m)}
					fromNote={m.step === "prepared" ? "Leaving the pool" : "Sent from the pool"}
					toNote={m.step === "claimed" ? "Arrived on Aztec" : "Arrives when claimed"}
				/>
			) : null}
			<Stepper steps={view.steps} label="Bridge steps" />
			<NoticeLog lines={view.log} />
			{m.failure ? <FailureCallout failure={m.failure} /> : <NowPanel m={m} />}
			{m.step === "claimable" && m.phase === "ready" ? <NextYou /> : null}
			{m.step === "claimed" ? (
				<div className="grid justify-items-start gap-3">
					<Callout tone="ok" title="Claimed" role="status">
						The funds are on Aztec under the same label.
					</Callout>
					<ActionButton
						variant="primary"
						onClick={() => {
							bridge.close()
							go("home")
						}}
					>
						Back to balances
					</ActionButton>
				</div>
			) : (
				<p className="text-center text-xs text-ink-3">
					Safe to close this tab: this bridge can be picked up again from your Ethereum signature and the chain.
				</p>
			)}
		</div>
	)
}
