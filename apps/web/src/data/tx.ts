/**
 * What an Aztec action's answer means on screen. Nothing here resends: a dropped transaction stays
 * the user's call once the balances say what happened.
 */
import { codeOf, isUserRejection, type UiCode } from "./errors"
import type { Sent } from "./ports"

export type TxAction = "transferPrivate" | "unshield" | "shield" | "ragequit" | "exitPublic"

/** `reason` is untrusted chain text: it reaches the screen only through `revertCopy`. */
export type TxOutcome = { ok: true } | { ok: false; code: UiCode; reason?: string }

export function sentOutcome(action: TxAction, sent: Sent): TxOutcome {
	if (sent.status === "success") return { ok: true }
	if (sent.status === "dropped") return { ok: false, code: "TX_DROPPED" }
	return { ok: false, code: action === "unshield" ? "UNSHIELD_REVERTED" : "TX_REVERTED", ...(sent.reason ? { reason: sent.reason } : {}) }
}

/** A thrown send: the wallet's no, a coded refusal, or an outcome the page cannot know. */
export function thrownOutcome(err: unknown): TxOutcome {
	if (isUserRejection(err)) return { ok: false, code: "WALLET_REJECTED" }
	return { ok: false, code: codeOf(err) ?? "UNKNOWN" }
}

/**
 * A reverted unshield leaves the account's notes in a state the wallet settles only once that block is
 * final, so a change-making spend before then could clash with it. Final means the node's proven block
 * has reached it; an unread proven block is not final.
 */
export const isFinal = (revertBlock: number, proven: number | undefined): boolean => proven !== undefined && proven >= revertBlock

/** Actions that spend notes and make change; an exact-chunk ragequit leaves none. */
export const MAKES_CHANGE: ReadonlySet<TxAction> = new Set(["transferPrivate", "unshield"])
