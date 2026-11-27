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
import { AllowListError, BridgeFailure, codeOf } from "../errors"
import { NO_LIST_CODES, noListCode } from "../list-post"
import type { AllowListPort, AllowListView, AztecPort, AztecSendHooks, Sent } from "../ports"
import type { AztecAddress, LabelPath, Origin } from "../stack-types"
import { PROVING_BUDGET_SEC } from "./allow-list"
import { type AztecDeps, boundTo, sendThroughWallet } from "./aztec"
import { listsKey } from "./snapshot-protocol"

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
 *   against or the record carries none, and the allow list's own `LIST_*` failures when it could not be
 *   checked or its record could not be read
 */
export async function checkedPath(allowList: TokenSendDeps["allowList"], label: bigint, origin: Origin): Promise<LabelPath> {
	let view = await recordNow(allowList)
	// A check can wait behind others, a download and a tree build, while new roots land and chain time
	// passes. What it says stands only once the record read after it still commits to the lists it was
	// checked against, roots and lengths: a path then also needs that record young enough, and a refusal
	// is final. A list that keeps moving past that many checks is too new to spend against yet.
	for (let checks = 0; checks < MAX_CHECKS; checks++) {
		const verdict = await verdictIn(allowList, view, label, origin)
		const after = await recordNow(allowList)
		if (listsKey(after.record) === listsKey(view.record)) {
			if ("refuse" in verdict) throw new BridgeFailure(verdict.refuse)
			if (!rootFresh(after.record, after.nowSec + PROVING_BUDGET_SEC)) throw new BridgeFailure("LIST_STALE")
			return verdict.path
		}
		view = after
	}
	throw new BridgeFailure("LIST_STALE")
}

const MAX_CHECKS = 3

/** The record now. A read that fails leaves nothing decided before any handoff: the list is unreadable. */
const recordNow = (allowList: TokenSendDeps["allowList"]): Promise<AllowListView> =>
	allowList.current().catch((err: unknown) => {
		throw codeOf(err) ? err : new AllowListError("LIST_UNAVAILABLE")
	})

type Verdict = { path: LabelPath } | { refuse: "LABEL_ABSENT" | "LIST_STALE" }

async function verdictIn(allowList: TokenSendDeps["allowList"], view: AllowListView, label: bigint, origin: Origin): Promise<Verdict> {
	// A record with no list, before the first post or while it is being reset, is a list too old to spend against.
	if (noListCode(view.record)) return { refuse: "LIST_STALE" }
	const check = await allowList.check(view, label, origin).catch((err: unknown) => {
		// The check met a record with no list on its own (its 404 fallback read one): the same refusal.
		if (err instanceof AllowListError && NO_LIST_CODES.has(err.code)) return null
		throw err
	})
	if (check === null || check.state === "STALE_ROOT") return { refuse: "LIST_STALE" }
	return check.state === "ABSENT" ? { refuse: "LABEL_ABSENT" } : { path: check.path }
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
