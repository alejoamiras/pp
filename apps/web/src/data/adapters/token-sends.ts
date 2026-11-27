/**
 * The token's checked spends for a stack build. A spend proves its label is on the allow list, so the
 * label's path comes from the latest record right before the send is built, and a label the list does
 * not hold, or a list too old to spend against, sends nothing. Each spend then goes out like every
 * other Aztec send, through `sendThroughWallet`. The check, the payloads and the send stay apart, so a
 * caller can put a checked call into a payload of its own.
 */
import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
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

const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

/**
 * `label`'s path under `origin` in the latest list.
 * @throws `LABEL_ABSENT` when the list does not hold it, `LIST_STALE` when the list is too old to spend
 *   against, and the allow list's own `LIST_*` failures when it could not be checked
 */
export async function checkedPath(allowList: TokenSendDeps["allowList"], label: bigint, origin: Origin): Promise<LabelPath> {
	await pathAt(allowList, label, origin)
	// The first check can wait behind others, a download and a tree build, while a new record lands or
	// this one ages out. A second read of the latest record finds the list already loaded for unchanged
	// roots, so the path sent is one the record just before the send holds and is fresh for.
	return pathAt(allowList, label, origin)
}

async function pathAt(allowList: TokenSendDeps["allowList"], label: bigint, origin: Origin): Promise<LabelPath> {
	const check = await allowList.check(await allowList.current(), label, origin)
	if (check.state === "ABSENT") throw new BridgeFailure("LABEL_ABSENT")
	if (check.state === "STALE_ROOT") throw new BridgeFailure("LIST_STALE")
	return check.path
}

/**
 * The token's spends as payloads paid by the SponsoredFPC, each with a path `checkedPath` read. Building
 * one asks nothing of `wallet`; it only carries the contract handle.
 */
export function spendPayloads(d: Pick<TokenSendDeps, "sponsoredFpc"> & { token: AztecAddress }) {
	const fee = { paymentMethod: new SponsoredFeePaymentMethod(sdk(d.sponsoredFpc)) }
	const token = (wallet: Wallet) => Contract.at(sdk(d.token), labelledTokenArtifact, wallet)
	const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })
	return {
		transferPrivate: (
			wallet: Wallet,
			a: { to: AztecAddress; amount: bigint; label: bigint },
			path: LabelPath,
		): Promise<ExecutionPayload> =>
			token(wallet).methods.transfer_private(sdk(a.to), a.amount, new Fr(a.label), pathArg(path)).request({ fee }),
		unshield: (wallet: Wallet, a: { amount: bigint; label: bigint }, path: LabelPath): Promise<ExecutionPayload> =>
			token(wallet).methods.unshield(a.amount, new Fr(a.label), pathArg(path)).request({ fee }),
	}
}

export function stackTokenSends(d: TokenSendDeps): Pick<AztecPort, "transferPrivate" | "unshield"> {
	const payloads = spendPayloads({ token: d.aztec.deployment.token, sponsoredFpc: d.sponsoredFpc })
	const spend = async (
		from: AztecAddress,
		at: { label: bigint; origin: Origin },
		on: AztecSendHooks,
		build: (wallet: Wallet, path: LabelPath) => Promise<ExecutionPayload>,
	): Promise<Sent> => {
		const path = await checkedPath(d.allowList, at.label, at.origin)
		const payload = await build(boundTo(d.aztec, on.epoch).wallet, path)
		return sendThroughWallet(d.aztec, { epoch: on.epoch, from, payload, contracts: ["token"], handoff: () => on.handoff() })
	}
	return {
		transferPrivate: (from, a, on) => spend(from, a, on, (wallet, path) => payloads.transferPrivate(wallet, a, path)),
		unshield: (from, a, on) => spend(from, a, on, (wallet, path) => payloads.unshield(wallet, a, path)),
	}
}
