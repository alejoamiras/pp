/**
 * One bridge's state on screen, as a pure reducer over `UiStep = "preparing" | BridgeStep`. The
 * driver (`bridge-driver.ts`) dispatches the events; an event that does not fit the current state
 * leaves it unchanged, which is how a second Submit is ignored.
 */
import type { Hash, Hex } from "viem"
import type { AztecAddress, BridgeRecordView, BridgeStep, StaleRootCode } from "./stack-types"
import type { UiCode } from "./errors"
import type { Attempt } from "./ports"

export type UiStep = "preparing" | BridgeStep
type PlainStep = Exclude<UiStep, { error: string }>

/** What is happening inside the step; `ready` means it is the user's move (Submit, or Claim). */
export type Phase = "idle" | "preflight" | "ready" | "starting" | "proving" | "sending" | "waiting" | "pending" | "done" | "failed"

/** The one next action a failure allows; "none" offers no send at all. */
export type Offer = "prove-again" | "send-again" | "prepare-again" | "claim" | "switch-chain" | "switch-account" | "none"

export interface Failure {
	code: UiCode
	during: PlainStep
	offer: Offer
	stale?: StaleRootCode | null
	/** Untrusted text from the chain (a revert reason); interpolate only. */
	reason?: string
	l1TxHash?: Hash
}

/** A passed preflight: valid for this recipient and Aztec epoch, from `at` on the injected timer. */
export interface PreflightBinding {
	recipient: AztecAddress
	epoch: number
	at: number
}

export type Notice =
	| { kind: "reproving"; code: StaleRootCode }
	| { kind: "refused"; code: UiCode }
	| { kind: "declined" }
	| { kind: "claim-declined" }

export interface BridgeMachine {
	step: UiStep
	phase: Phase
	binding: PreflightBinding | null
	attempt: Attempt | null
	record: BridgeRecordView | null
	failure: Failure | null
	/** Oldest first, at most `MAX_NOTICES`. */
	notices: readonly Notice[]
	/** A claim that may have gone out: the chain dropped it or the wallet never answered; never resent by the page. Its hash when known. */
	claimTx: Hex | null
}

export type BridgeEvent =
	| { type: "preflight" }
	| { type: "preflighted"; binding: PreflightBinding }
	| { type: "invalidate" }
	| { type: "refused"; code: UiCode }
	| { type: "submit"; attempt: Attempt }
	| { type: "proving" }
	| { type: "proved" }
	| { type: "reproving"; code: StaleRootCode }
	| { type: "handoff" }
	| { type: "declined" }
	| { type: "record"; record: BridgeRecordView }
	| { type: "claimable" }
	| { type: "claiming" }
	| { type: "claim-declined" }
	| { type: "claim-pending"; txHash: Hex | null }
	| { type: "claimed" }
	| { type: "failed"; failure: Failure }
	| { type: "reset" }

export const MAX_NOTICES = 12

export const initialBridge: BridgeMachine = {
	step: "preparing",
	phase: "idle",
	binding: null,
	attempt: null,
	record: null,
	failure: null,
	notices: [],
	claimTx: null,
}

/** The offer that follows each outcome code; anything unlisted offers a fresh proof. */
const OFFERS: Partial<Record<UiCode, Offer>> = {
	UNCERTAIN: "send-again",
	IN_FLIGHT: "none",
	CONSUMED_ELSEWHERE: "none",
	UNKNOWN: "none",
	NOT_GRANTED: "none",
	NOT_CLAIMABLE: "none",
	CHAIN_MISMATCH: "switch-chain",
	SENDER_IS_OWNER: "switch-account",
	CONTEXT_CHANGED: "prepare-again",
	RECIPIENT_INVALID: "prepare-again",
	RECIPIENT_NOT_IN_WALLET: "prepare-again",
	FEE_PATH_FAILED: "prepare-again",
	CLAIM_REVERTED: "claim",
	CLAIM_FAILED: "claim",
}

export const offerFor = (code: UiCode): Offer => OFFERS[code] ?? "prove-again"

const isError = (step: UiStep): step is { error: string } => typeof step === "object"
const at = (s: BridgeMachine, step: PlainStep, ...phases: Phase[]) => !isError(s.step) && s.step === step && phases.includes(s.phase)
const failedWith = (s: BridgeMachine, ...offers: Offer[]) => s.phase === "failed" && s.failure !== null && offers.includes(s.failure.offer)
const notice = (s: BridgeMachine, n: Notice): BridgeMachine => ({ ...s, notices: [...s.notices, n].slice(-MAX_NOTICES) })

const PHASE_OF: Record<PlainStep, Phase> = {
	preparing: "idle",
	prepared: "sending",
	submitted: "waiting",
	mined: "waiting",
	claimable: "ready",
	claiming: "sending",
	claimed: "done",
}

/** A record read back from the session: its step is the chain's, so it replaces what the page assumed. */
function fromRecord(s: BridgeMachine, record: BridgeRecordView): BridgeMachine {
	if (!isError(record.step)) return { ...s, record, step: record.step, phase: PHASE_OF[record.step], failure: null }
	const code = (record.step.error === "REVERTED" ? "REVERTED" : "UNKNOWN") satisfies UiCode
	const failure: Failure = { code, during: "submitted", offer: offerFor(code), ...(record.l1TxHash ? { l1TxHash: record.l1TxHash } : {}) }
	return { ...s, record, step: { error: code }, phase: "failed", failure }
}

/** Failures a new attempt may follow; "none" and "claim" never lead back to a spend. */
const RETRY: Offer[] = ["prove-again", "send-again", "prepare-again", "switch-chain", "switch-account"]
const canPreflight = (s: BridgeMachine) => at(s, "preparing", "idle", "ready", "starting") || failedWith(s, ...RETRY)
/** The driver re-runs a missing or stale preflight itself, so a Submit needs no binding here. */
const canSubmit = (s: BridgeMachine) => (at(s, "preparing", "idle", "preflight", "ready") && s.attempt === null) || failedWith(s, ...RETRY)

type Handlers = { [K in BridgeEvent["type"]]: (s: BridgeMachine, e: Extract<BridgeEvent, { type: K }>) => BridgeMachine }

const HANDLERS: Handlers = {
	preflight: (s) => (canPreflight(s) ? { ...s, step: "preparing", phase: "preflight", binding: null, failure: null } : s),
	preflighted: (s, e) => (at(s, "preparing", "preflight") ? { ...s, phase: s.attempt ? "starting" : "ready", binding: e.binding } : s),
	invalidate: (s) =>
		at(s, "preparing", "idle", "preflight", "ready") && s.attempt === null ? { ...s, phase: "idle", binding: null } : s,
	refused: (s, e) => notice(s, { kind: "refused", code: e.code }),
	submit: (s, e) => (canSubmit(s) ? { ...s, step: "preparing", phase: "starting", attempt: e.attempt, failure: null, record: null } : s),
	proving: (s) => (at(s, "preparing", "starting") ? { ...s, phase: "proving" } : s),
	proved: (s) => (at(s, "preparing", "proving") ? { ...s, step: "prepared", phase: "sending" } : s),
	reproving: (s, e) => (at(s, "prepared", "sending") ? notice(s, { kind: "reproving", code: e.code }) : s),
	handoff: (s) => (at(s, "prepared", "sending") ? { ...s, step: "submitted", phase: "waiting" } : s),
	declined: (s) =>
		at(s, "prepared", "sending") || at(s, "submitted", "waiting")
			? notice({ ...s, step: "preparing", phase: "idle", attempt: null, binding: null }, { kind: "declined" })
			: s,
	record: (s, e) => (s.step === "claimed" ? s : fromRecord(s, e.record)),
	claimable: (s) => (at(s, "mined", "waiting") || at(s, "submitted", "waiting") ? { ...s, step: "claimable", phase: "ready" } : s),
	claiming: (s) =>
		at(s, "claimable", "ready") || failedWith(s, "claim") ? { ...s, step: "claiming", phase: "sending", failure: null } : s,
	"claim-declined": (s) =>
		at(s, "claiming", "sending") ? notice({ ...s, step: "claimable", phase: "ready" }, { kind: "claim-declined" }) : s,
	// From `claimable`: a record reopened while its claim is still out.
	"claim-pending": (s, e) =>
		at(s, "claiming", "sending") || at(s, "claimable", "ready") ? { ...s, step: "claiming", phase: "pending", claimTx: e.txHash } : s,
	claimed: (s) => (at(s, "claiming", "sending", "pending") ? { ...s, step: "claimed", phase: "done" } : s),
	failed: (s, e) => (s.step === "claimed" ? s : { ...s, step: { error: e.failure.code }, phase: "failed", failure: e.failure }),
	reset: () => initialBridge,
}

export function bridgeReducer(s: BridgeMachine, e: BridgeEvent): BridgeMachine {
	const handle = HANDLERS[e.type] as (s: BridgeMachine, e: BridgeEvent) => BridgeMachine
	return handle(s, e)
}
