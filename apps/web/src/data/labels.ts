/**
 * What a label's allow-list state means on screen. ABSENT is the snapshot server's claim, while ACTIVE
 * is proved by a path to the posted root. One snapshot also cannot tell a label never approved from
 * one dropped. So the copy never
 * says a label was revoked or removed: a fresh shield (origin 1) reads as not enabled yet, a bridged
 * label (origin 0) as not found in the latest list, with a fresh read offered and no advice to leave:
 * an absence alone never recommends a public exit. Leaving to Ethereum never reads the allow list, so
 * ragequit stays open in every state.
 */
import type { LabelState, Origin } from "./stack-types"
import type { Tone } from "../ui"
import { type AllowListCode, messageOf } from "./errors"

export interface LabelView {
	text: string
	tone: Tone
	meaning: string
	can: { send: boolean; unshield: boolean; ragequit: boolean }
	/** Why send and unshield are closed; empty when they are open. */
	reason: string
	/** Offer a fresh read of the allow list beside the ragequit. */
	checkAgain: boolean
}

const CLOSED = { send: false, unshield: false, ragequit: true }

export function labelView(origin: Origin, state: LabelState): LabelView {
	if (state === "ACTIVE")
		return {
			text: origin === 1 ? "Funds enabled" : "Active",
			tone: "ok",
			meaning:
				origin === 1
					? "A shielded label the posted allow list now includes: sends and unshields work."
					: "In the posted allow list: sends and unshields work.",
			can: { send: true, unshield: true, ragequit: true },
			reason: "",
			checkAgain: false,
		}
	if (state === "STALE_ROOT")
		return {
			text: "List out of date",
			tone: "wait",
			meaning: "The posted list is too old for a private spend: wait for the next post. Leaving still works.",
			can: CLOSED,
			reason: "Send and Unshield wait for the next allow-list post",
			checkAgain: false,
		}
	if (origin === 1)
		return {
			text: "Not enabled yet",
			tone: "wait",
			meaning: "A shielded label not in the allow list this page last read. Send and Unshield open once it is approved.",
			can: CLOSED,
			reason: "Send and Unshield open once the label is approved",
			checkAgain: false,
		}
	return {
		text: "Not found in the latest list",
		tone: "attn",
		meaning: "Not found in the list the server sent, which does not show the label was dropped. Check again later.",
		can: CLOSED,
		reason: "Send and Unshield wait until the label is found in the allow list",
		checkAgain: true,
	}
}

const FAILURE_TEXT: Record<AllowListCode, string> = {
	LIST_TIMEOUT: "Allow list timed out",
	LIST_MISMATCH: "Allow list does not match the chain",
	LIST_OVERSIZED: "Allow list too large",
	LIST_CANCELLED: "Check stopped",
	LIST_UNAVAILABLE: "Allow list unavailable",
}

/** A label whose list could not be checked: its state is unknown, so only the ragequit stays open. */
export function listFailureView(code: AllowListCode): LabelView {
	return {
		text: FAILURE_TEXT[code],
		tone: code === "LIST_CANCELLED" ? "neutral" : "bad",
		meaning: messageOf(code),
		can: CLOSED,
		reason: "Send and Unshield wait until the allow list can be checked",
		checkAgain: code !== "LIST_UNAVAILABLE",
	}
}
