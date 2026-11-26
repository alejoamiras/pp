import { useApp } from "../../app/context"
import type { Failure, Offer } from "../../data/bridge-machine"
import { messageOf, type UiCode } from "../../data/errors"
import { ActionButton, Callout } from "../../ui"

const TITLES: Partial<Record<UiCode, string>> = {
	UNCERTAIN: "We can't see your transaction yet",
	IN_FLIGHT: "A bridge from this note may be in flight",
	CONSUMED_ELSEWHERE: "This note was spent elsewhere",
	PROVE_TIMEOUT: "Proving took too long",
	CONTEXT_CHANGED: "Your wallet changed",
	REVERTED: "The Ethereum transaction reverted",
	CLAIM_REVERTED: "The claim reverted",
}

const BUTTONS: Record<Exclude<Offer, "none">, string> = {
	"prove-again": "Prove again",
	"send-again": "Send again",
	"prepare-again": "Start again",
	claim: "Claim again",
	"switch-chain": "Try again",
	"switch-account": "Try again",
}

/** A stopped bridge: what happened, what was not sent, and the one next step the failure allows. */
export function FailureCallout({ failure }: { failure: Failure }) {
	const { bridge, connection } = useApp()
	const amount = bridge.subject?.amount ?? null
	const recipient = connection?.accounts[0] ?? ""
	const act = (offer: Offer) => {
		if (offer === "prepare-again") return bridge.restart()
		if (offer === "claim") return void bridge.claim()
		if (amount !== null) void bridge.submit(amount, recipient, offer === "send-again")
	}
	const { offer } = failure
	return (
		<Callout tone="bad" title={TITLES[failure.code] ?? "The bridge stopped"} role="alert">
			<p data-testid="bridge-failure" data-code={failure.code}>
				{messageOf(failure.code)}
			</p>
			{failure.reason ? <p className="mt-1">Reported by the chain: {failure.reason}</p> : null}
			{offer === "send-again" ? (
				<p className="mt-1 font-semibold">A second transaction may revert and cost gas if the first one lands.</p>
			) : null}
			{offer !== "none" ? (
				<div className="mt-2">
					<ActionButton variant="primary" onClick={() => act(offer)}>
						{BUTTONS[offer]}
					</ActionButton>
				</div>
			) : null}
		</Callout>
	)
}
