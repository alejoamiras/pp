/**
 * What a label's allow-list state means on screen. ABSENT is the snapshot server's claim, not proof:
 * a server can withhold part of the tree, or collapse it and still match the root, while ACTIVE cannot
 * be faked. One snapshot also cannot tell a label never approved from one dropped. So the copy never
 * says a label was revoked or removed: a fresh shield (origin 1) reads as awaiting approval, a bridged
 * label (origin 0) as not found in the latest list, with a fresh read offered. Leaving to Ethereum
 * never reads the allow list, so ragequit stays open in every state.
 */
import type { LabelState, Origin } from "./stack-types"
import type { Tone } from "../ui"

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
			text: "Active",
			tone: "ok",
			meaning: "In the posted allow list: sends and unshields work.",
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
			text: "Awaiting approval",
			tone: "wait",
			meaning: "Not in the allow list yet: it can only leave to Ethereum.",
			can: CLOSED,
			reason: "Send and Unshield open once the label is approved",
			checkAgain: false,
		}
	return {
		text: "Not found in the latest list",
		tone: "attn",
		meaning: "Not found in the latest allow list. Check again, or leave to Ethereum (ragequit).",
		can: CLOSED,
		reason: "Send and Unshield wait until the label is found in the allow list",
		checkAgain: true,
	}
}
