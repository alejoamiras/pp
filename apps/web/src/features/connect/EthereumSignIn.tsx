import { useApp } from "../../app/context"
import { useLive } from "../../app/live"
import { chainName } from "../../data/chain"
import { messageOf } from "../../data/errors"
import { ActionButton, Callout } from "../../ui"

/** Signed out, signing, or failed: the chain is checked before the derivation signature is asked for. */
export function EthereumSignIn() {
	const { eth, live, source } = useApp()
	const { account, chainId } = useLive(live)
	const target = source.deployment.chainId
	const wrongChain = chainId !== null && chainId !== target
	const status = eth.status
	if (status.kind === "signing")
		return (
			<Callout tone="wait" busy role="status" title="Approve the signature in your Ethereum wallet">
				It derives your pool keys in this page. It sends nothing and costs nothing.
			</Callout>
		)
	const reason = account === null ? messageOf("NO_SENDER") : wrongChain ? `Switch your wallet to ${chainName(target)} first.` : undefined
	return (
		<div className="grid justify-items-start gap-3" data-testid="eth-sign-in-panel">
			<p className="text-ink-2">
				Sign in with the Ethereum account that owns your pool notes. Signing derives your pool keys in this page; it sends nothing
				and costs nothing.
			</p>
			{wrongChain ? (
				<Callout tone="attn" title="Your Ethereum wallet is on another network">
					It is on {chainName(chainId)}. Switch it to {chainName(target)}, then sign in.
				</Callout>
			) : null}
			{status.kind === "error" ? (
				<Callout tone="bad" title="Not signed in" role="alert">
					{messageOf(status.code)}
				</Callout>
			) : null}
			<ActionButton variant="primary" data-testid="eth-sign-in" disabledReason={reason} onClick={() => void eth.signIn()}>
				{status.kind === "error" ? "Sign in again" : "Sign in with Ethereum"}
			</ActionButton>
		</div>
	)
}
