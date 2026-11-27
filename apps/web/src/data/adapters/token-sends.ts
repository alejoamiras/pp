/**
 * The token's checked spends for a stack build. A spend proves its label is on the allow list, so the
 * label's path comes from the latest record right before the send is built, and a label the list does
 * not hold, or a list too old to spend against, sends nothing. Each spend then goes out like every
 * other Aztec send, through `sendThroughWallet`.
 */
import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { labelledTokenArtifact } from "@pp/bridge-core/artifacts"
import { BridgeFailure } from "../errors"
import type { AllowListPort, AztecPort, AztecSendHooks, Sent } from "../ports"
import type { AztecAddress, LabelPath, Origin } from "../stack-types"
import { type AztecDeps, boundTo, sendThroughWallet } from "./aztec"

export interface TokenSendDeps {
	aztec: AztecDeps
	allowList: Pick<AllowListPort, "current" | "check">
	/** Pays every spend: the fee payer is public, and an account paying its own would link it to the spend. */
	sponsoredFpc: AztecAddress
}

type PathArg = { index: number; depth: number; siblings: bigint[] }

const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

/**
 * `label`'s path under `origin` in the latest list.
 * @throws `LABEL_ABSENT` when the list does not hold it, `LIST_STALE` when the list is too old to spend
 *   against, and the allow list's own `LIST_*` failures when it could not be checked
 */
async function checkedPath(d: TokenSendDeps, label: bigint, origin: Origin): Promise<PathArg> {
	const view = await d.allowList.current()
	const check = await d.allowList.check(view, label, origin)
	if (check.state === "ABSENT") throw new BridgeFailure("LABEL_ABSENT")
	if (check.state === "STALE_ROOT") throw new BridgeFailure("LIST_STALE")
	const p: LabelPath = check.path
	return { index: p.index, depth: p.depth, siblings: [...p.siblings] }
}

export function stackTokenSends(d: TokenSendDeps): Pick<AztecPort, "transferPrivate" | "unshield"> {
	const fee = { paymentMethod: new SponsoredFeePaymentMethod(sdk(d.sponsoredFpc)) }
	const spend = async (
		from: AztecAddress,
		at: { label: bigint; origin: Origin },
		on: AztecSendHooks,
		call: (token: Contract, path: PathArg) => ContractFunctionInteraction,
	): Promise<Sent> => {
		const path = await checkedPath(d, at.label, at.origin)
		const token = Contract.at(sdk(d.aztec.deployment.token), labelledTokenArtifact, boundTo(d.aztec, on.epoch).wallet)
		const payload = await call(token, path).request({ fee })
		return sendThroughWallet(d.aztec, { epoch: on.epoch, from, payload, contracts: ["token"], handoff: () => on.handoff() })
	}
	return {
		transferPrivate: (from, a, on) =>
			spend(from, a, on, (token, path) => token.methods.transfer_private(sdk(a.to), a.amount, new Fr(a.label), path)),
		unshield: (from, a, on) => spend(from, a, on, (token, path) => token.methods.unshield(a.amount, new Fr(a.label), path)),
	}
}
