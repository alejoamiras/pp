/**
 * View models: what the screens render, derived from port data and the bridge machine. Every age is
 * chain time from `ChainClock`, labelled as such; the browser's clock would be wrong on a local chain,
 * where time moves only with blocks.
 */
import type { PoolNoteStatus, PoolNoteView, RootRecord } from "./a7"
import type { BridgeMachine, Notice, Offer } from "./bridge-machine"
import { messageOf, reprovingMessage } from "./errors"
import type { ChainClock } from "./ports"
import type { StepStatus, Tone } from "../ui"

const NOTE_COPY: Record<PoolNoteStatus, { text: string; tone: Tone } | null> = {
	inactive: { text: "Unknown", tone: "neutral" },
	pending: { text: "Not approved yet", tone: "wait" },
	approved: { text: "Approved", tone: "ok" },
	revoked: { text: "Approval withdrawn", tone: "bad" },
	exiting: { text: "Leaving the pool", tone: "attn" },
	spent: null,
	exited: null,
}

const NOT_BRIDGEABLE: Partial<Record<PoolNoteStatus, string>> = {
	inactive: "The pool has not classified this note",
	pending: "The pool has not approved this note",
	revoked: "The pool withdrew this note's approval; it can return",
	exiting: "This note is leaving the pool; it can return after a reorg",
}

export interface NoteRow {
	note: PoolNoteView
	text: string
	tone: Tone
	/** Why there is no bridge for this note; absent when it can be bridged. */
	blocked?: string
}

export interface PoolNotesView {
	rows: NoteRow[]
	/** Zero-value notes (a whole-note bridge leaves one), shown as a count. */
	emptyCount: number
}

/** Spent and exited notes are hidden; only approved notes with a value offer a bridge. */
export function poolNotesView(notes: readonly PoolNoteView[]): PoolNotesView {
	const rows: NoteRow[] = []
	let emptyCount = 0
	for (const note of notes) {
		const copy = NOTE_COPY[note.status]
		if (copy === null) continue
		if (note.value === 0n) {
			emptyCount++
			continue
		}
		const blocked = NOT_BRIDGEABLE[note.status]
		rows.push({ note, ...copy, ...(blocked ? { blocked } : {}) })
	}
	return { rows, emptyCount }
}

export interface ChainAge {
	seconds: bigint
	text: string
}

/** `then` and `now` are chain timestamps in seconds. A `then` ahead of `now` reads as just now. */
export function chainAge(then: bigint, now: bigint): ChainAge {
	const seconds = now > then ? now - then : 0n
	const unit =
		seconds < 60n
			? `${seconds} s`
			: seconds < 3600n
				? `${seconds / 60n} min`
				: seconds < 86_400n
					? `${seconds / 3600n} h`
					: `${seconds / 86_400n} d`
	return { seconds, text: seconds === 0n ? "just now (chain time)" : `${unit} ago (chain time)` }
}

/** How long ago the allow list was posted, against the latest Aztec block. */
export async function allowListAge(clock: ChainClock, record: RootRecord): Promise<ChainAge> {
	return chainAge(record.rootTime, await clock.aztecNow())
}

const STEPS = [
	{ key: "prepared", name: "Prepared" },
	{ key: "submitted", name: "Submitted" },
	{ key: "mined", name: "Mined" },
	{ key: "claimable", name: "Claimable" },
	{ key: "claiming", name: "Claiming" },
	{ key: "claimed", name: "Claimed" },
] as const
const INDEX: Record<string, number> = { preparing: 0, prepared: 1, submitted: 2, mined: 3, claimable: 4, claiming: 4, claimed: 6 }

export interface BridgeView {
	steps: { key: string; name: string; status: StepStatus }[]
	/** The failure's sentence, or `null`. */
	message: string | null
	offer: Offer | null
	/** One line per notice, oldest first. */
	log: string[]
}

function noticeText(n: Notice): string {
	if (n.kind === "reproving") return reprovingMessage(n.code)
	if (n.kind === "refused") return messageOf(n.code)
	if (n.kind === "declined") return messageOf("WALLET_REJECTED")
	return "The wallet declined the claim. Claim again when you are ready."
}

/** The step list: steps before the current one are done; a failure marks the step it stopped. */
export function bridgeView(m: BridgeMachine): BridgeView {
	const failed = m.failure !== null && typeof m.step === "object"
	const current = failed ? INDEX[m.failure?.during ?? "preparing"] : INDEX[m.step as string]
	const steps = STEPS.map((s, i) => ({
		...s,
		status: (i < (current ?? 0) ? "done" : i === current ? (failed ? "failed" : "current") : "todo") as StepStatus,
	}))
	return {
		steps,
		message: m.failure ? messageOf(m.failure.code) : null,
		offer: m.failure?.offer ?? null,
		log: m.notices.map(noticeText),
	}
}
