/**
 * Binds a send to the wallet context the user confirmed it in. Its handoff runs right before the
 * wallet is asked to send and refuses once that context is gone, so a change while the send is held
 * sends nothing.
 */
import { type Address, isAddressEqual } from "viem"
import { BridgeFailure } from "./errors"
import type { AztecSendHooks, SubmitHooks } from "./ports"
import type { AztecAddress } from "./stack-types"

/** The live wallet context, read synchronously at the confirm and again at the handoff. */
export interface SendContext {
	readonly account: Address | null
	readonly chainId: number | null
	readonly epoch: number | null
	readonly aztecAccounts: readonly AztecAddress[]
}

const changed = () => new BridgeFailure("CONTEXT_CHANGED")

/**
 * An Aztec send from `from`, bound to the connection that lists it now.
 * @throws BridgeFailure `CONTEXT_CHANGED` when no connection lists it
 */
export function bindAztecSend(live: () => SendContext, from: AztecAddress): AztecSendHooks {
	const { epoch, aztecAccounts } = live()
	if (epoch === null || !aztecAccounts.includes(from)) throw changed()
	return {
		epoch,
		handoff() {
			const now = live()
			if (now.epoch !== epoch || !now.aztecAccounts.includes(from)) throw changed()
		},
	}
}

/**
 * An Ethereum send from `sender` on `chainId`. `refused` tells a failure the handoff caused, which
 * sent nothing, from one the wallet or the chain reported.
 */
export function bindL1Send(
	live: () => SendContext,
	sender: Address,
	chainId: number,
): Pick<SubmitHooks, "handoff"> & { refused(): boolean } {
	let refused = false
	return {
		handoff() {
			const now = live()
			if (now.account !== null && isAddressEqual(now.account, sender) && now.chainId === chainId) return
			refused = true
			throw changed()
		},
		refused: () => refused,
	}
}
