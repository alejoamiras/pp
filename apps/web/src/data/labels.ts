/**
 * What a label's allow-list state means on screen. One allow-list snapshot cannot tell a label never
 * approved from one removed, so the copy leans on the origin: a fresh shield (origin 1) is awaiting
 * approval; a bridged label (origin 0) that is absent is out of the list. Leaving to Ethereum never
 * reads the allow list, so ragequit stays open in every state.
 */
import type { LabelState, Origin } from "./a7"
import type { Tone } from "../ui"

export interface LabelView {
	text: string
	tone: Tone
	meaning: string
	can: { send: boolean; unshield: boolean; ragequit: boolean }
	/** Why send and unshield are closed; empty when they are open. */
	reason: string
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
		}
	if (state === "STALE_ROOT")
		return {
			text: "List out of date",
			tone: "wait",
			meaning: "The posted list is too old for a private spend: wait for the next post. Leaving still works.",
			can: CLOSED,
			reason: "Send and Unshield wait for the next allow-list post",
		}
	if (origin === 1)
		return {
			text: "Awaiting approval",
			tone: "wait",
			meaning: "Not in the allow list yet: it can only leave to Ethereum.",
			can: CLOSED,
			reason: "Send and Unshield open once the label is approved",
		}
	return {
		text: "Not in the allow list",
		tone: "bad",
		meaning: "This label is not in the posted allow list: it can only leave to Ethereum.",
		can: CLOSED,
		reason: "Send and Unshield are closed for this label",
	}
}
