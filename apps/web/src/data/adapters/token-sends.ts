/**
 * The token's checked spends for a stack build. A spend proves its label is on the allow list, so the
 * label's path comes from the latest record right before the send is built, and a label the list does
 * not hold, or a list too old to spend against, sends nothing. Each spend then goes out like every
 * other Aztec send, through `sendThroughWallet`. The check, the payloads and the send stay apart, so a
 * caller can put a checked call into a payload of its own. A shield spends no label, so it reads no path.
 */
import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { labelledTokenArtifact } from "@pp/bridge-core/artifacts"
import { rootFresh } from "@pp/label-paths"
import { assertSpendable } from "../chunks"
import { BridgeFailure } from "../errors"
import type { AllowListPort, AllowListView, AztecPort, AztecSendHooks, Sent } from "../ports"
import type { AztecAddress, LabelPath, Origin } from "../stack-types"
import { PROVING_BUDGET_SEC } from "./allow-list"
import { type AztecDeps, boundTo, sendThroughWallet } from "./aztec"
import { rootsKey } from "./snapshot-protocol"

export interface TokenSendDeps {
	aztec: AztecDeps
	allowList: Pick<AllowListPort, "current" | "check">
	/** Pays every spend: the fee payer is public, and an account paying its own would link it to the spend. */
	sponsoredFpc: AztecAddress
	/** A label's note values as the connected wallet reports them when called. */
	notes: AztecPort["notesByLabel"]
	/** The account's public balance as the connected wallet reports it when called. */
	publicBalance: AztecPort["publicBalance"]
}

const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

/**
 * `label`'s path under `origin` in the latest list.
 * @throws `LABEL_ABSENT` when the list does not hold it, `LIST_STALE` when the list is too old to spend
 *   against, and the allow list's own `LIST_*` failures when it could not be checked
 */
export async function checkedPath(allowList: TokenSendDeps["allowList"], label: bigint, origin: Origin): Promise<LabelPath> {
	let view = await allowList.current()
	// A check can wait behind others, a download and a tree build, while new roots land and chain time
	// passes. Its path is taken only once the record read after it still has the roots it was checked
	// against and is still young enough at that read; a list that keeps moving past that many checks is
	// too new to spend against yet.
	for (let checks = 0; checks < MAX_CHECKS; checks++) {
		const path = await pathIn(allowList, view, label, origin)
		const after = await allowList.current()
		if (rootsKey(after.record) === rootsKey(view.record)) {
			if (!rootFresh(after.record, after.nowSec + PROVING_BUDGET_SEC)) throw new BridgeFailure("LIST_STALE")
			return path
		}
		view = after
	}
	throw new BridgeFailure("LIST_STALE")
}

const MAX_CHECKS = 3

async function pathIn(allowList: TokenSendDeps["allowList"], view: AllowListView, label: bigint, origin: Origin): Promise<LabelPath> {
	const check = await allowList.check(view, label, origin)
	if (check.state === "ABSENT") throw new BridgeFailure("LABEL_ABSENT")
	if (check.state === "STALE_ROOT") throw new BridgeFailure("LIST_STALE")
	return check.path
}

/** A label path as the token's methods take it. */
export const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })

/**
 * The token's sends as payloads paid by the SponsoredFPC; the label spends carry a path `checkedPath`
 * read. Building one asks nothing of `wallet`; it only carries the contract handle.
 */
export function spendPayloads(d: Pick<TokenSendDeps, "sponsoredFpc"> & { token: AztecAddress }) {
	const fee = { paymentMethod: new SponsoredFeePaymentMethod(sdk(d.sponsoredFpc)) }
	const token = (wallet: Wallet) => Contract.at(sdk(d.token), labelledTokenArtifact, wallet)
	return {
		transferPrivate: (
			wallet: Wallet,
			a: { to: AztecAddress; amount: bigint; label: bigint },
			path: LabelPath,
		): Promise<ExecutionPayload> =>
			token(wallet).methods.transfer_private(sdk(a.to), a.amount, new Fr(a.label), pathArg(path)).request({ fee }),
		unshield: (wallet: Wallet, a: { amount: bigint; label: bigint }, path: LabelPath): Promise<ExecutionPayload> =>
			token(wallet).methods.unshield(a.amount, new Fr(a.label), pathArg(path)).request({ fee }),
		shield: (wallet: Wallet, amount: bigint): Promise<ExecutionPayload> => token(wallet).methods.shield(amount).request({ fee }),
	}
}

export function stackTokenSends(d: TokenSendDeps): Pick<AztecPort, "transferPrivate" | "unshield" | "shield"> {
	const payloads = spendPayloads({ token: d.aztec.deployment.token, sponsoredFpc: d.sponsoredFpc })
	const send = async (from: AztecAddress, on: AztecSendHooks, build: (wallet: Wallet) => Promise<ExecutionPayload>): Promise<Sent> => {
		const payload = await build(boundTo(d.aztec, on.epoch).wallet)
		return sendThroughWallet(d.aztec, { epoch: on.epoch, from, payload, contracts: ["token"], handoff: () => on.handoff() })
	}
	const spend = async (
		from: AztecAddress,
		at: { label: bigint; origin: Origin; amount: bigint },
		on: AztecSendHooks,
		build: (wallet: Wallet, path: LabelPath) => Promise<ExecutionPayload>,
	): Promise<Sent> => {
		const path = await checkedPath(d.allowList, at.label, at.origin)
		// Read after the check's wait, so notes spent meanwhile (from another tab) refuse here, not in the
		// wallet, where a failed simulation cannot be told from a send that went out.
		assertSpendable(await d.notes(from, at.label), at.amount)
		return send(from, on, (wallet) => build(wallet, path))
	}
	return {
		transferPrivate: (from, a, on) => spend(from, a, on, (wallet, path) => payloads.transferPrivate(wallet, a, path)),
		unshield: (from, a, on) => spend(from, a, on, (wallet, path) => payloads.unshield(wallet, a, path)),
		shield: async (from, amount, on) => {
			// A balance spent since the dialog opened fails the wallet's simulation past the handoff, which holds the account.
			if ((await d.publicBalance(from)) < amount) throw new BridgeFailure("OVER_PUBLIC_BALANCE")
			return send(from, on, (wallet) => payloads.shield(wallet, amount))
		},
	}
}
