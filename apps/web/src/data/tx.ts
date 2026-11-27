/**
 * What an Aztec action's answer means on screen. Nothing here resends: a dropped transaction stays
 * the user's call once the balances say what happened.
 */
import { codeOf, isUserRejection, type UiCode } from "./errors"
import type { Hex } from "viem"
import type { Sent } from "./ports"

export type TxAction = "transferPrivate" | "unshield" | "shield" | "ragequit" | "exitPublic" | "exitPrivate"

/** What a reverted send of each action says; any other action reads `TX_REVERTED`. */
const REVERTED: Partial<Record<TxAction, UiCode>> = { unshield: "UNSHIELD_REVERTED", exitPrivate: "WITHDRAW_REVERTED" }

/** `reason` is untrusted chain text: it reaches the screen only through `revertCopy`. */
export type TxOutcome = { ok: true } | { ok: false; code: UiCode; reason?: string; txHash?: Hex }

export function sentOutcome(action: TxAction, sent: Sent): TxOutcome {
	if (sent.status === "success") return { ok: true }
	if (sent.status === "dropped") return { ok: false, code: "TX_DROPPED" }
	// Without a hash the wallet's send threw: whether it went out, only a reload and the wallet can tell.
	if (sent.status === "unconfirmed")
		return sent.txHash ? { ok: false, code: "TX_UNCONFIRMED", txHash: sent.txHash } : { ok: false, code: "UNKNOWN" }
	return { ok: false, code: REVERTED[action] ?? "TX_REVERTED", ...(sent.reason ? { reason: sent.reason } : {}) }
}

/** A thrown send: the wallet's no, a coded refusal, or an outcome the page cannot know. */
export function thrownOutcome(err: unknown): TxOutcome {
	if (isUserRejection(err)) return { ok: false, code: "WALLET_REJECTED" }
	return { ok: false, code: codeOf(err) ?? "UNKNOWN" }
}

/**
 * A reverted unshield or private exit leaves the account's notes in a state the wallet settles only once
 * that block is final, so a change-making spend before then could clash with it. Final means the node's proven block
 * has reached it; an unread proven block is not final.
 */
export const isFinal = (revertBlock: number, proven: number | undefined): boolean => proven !== undefined && proven >= revertBlock

/** Actions that spend notes and make change; an exact-chunk ragequit leaves none. */
export const MAKES_CHANGE: ReadonlySet<TxAction> = new Set(["transferPrivate", "unshield", "exitPrivate"])

/**
 * Change-making spends whose public step re-checks the label's roots, so they can land reverted after
 * the wallet proved them; such a revert holds `MAKES_CHANGE` until its block is final.
 */
export const REVERT_WAITS_FINALITY: ReadonlySet<TxAction> = new Set(["unshield", "exitPrivate"])
