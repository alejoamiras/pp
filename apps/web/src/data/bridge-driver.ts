/**
 * Runs one note's bridge against a `Session` and reports through `dispatch`. Proving waits two frames
 * so the pause message paints, then gives up after 60 s on the injected timer, because a failing prover
 * can hang without an error. A preflight is re-run at Submit once it is 9 minutes old, since bridge-core
 * keeps one for 10.
 */
import { type Address, type Hex, isAddressEqual } from "viem"
import type { AztecAddress, BridgeRecordView, PoolNoteView } from "./stack-types"
import type { BridgeEvent, Failure } from "./bridge-machine"
import { offerFor } from "./bridge-machine"
import { codeOf, isUserRejection, type UiCode } from "./errors"
import { parseAztecAddress } from "./parse"
import type { Attempt, Deployment, Proved, Sent, Session, SubmitHooks, Timer } from "./ports"
import { checkAttempt, type Found, type PriorKind, priorAttempt } from "./reconcile"

/** The prover hangs without an error on some internal failures; 60 s covers the first use's 21 MB fetch. */
export const PROVE_DEADLINE_MS = 60_000
/** bridge-core keeps a preflight for 10 minutes; re-running at 9 leaves room for proving. */
export const PREFLIGHT_FRESH_MS = 9 * 60_000

/** The live wallet context the app keeps current from wallet events; read synchronously at each check. */
export interface LiveContext {
	/** The owner whose session is open; `null` once it closes. */
	readonly owner: Address | null
	/** The Ethereum wallet's selected account. */
	readonly account: Address | null
	readonly chainId: number | null
	readonly deployment: string
	/** The Aztec connection's epoch; `null` when disconnected. */
	readonly epoch: number | null
	readonly aztecAccounts: readonly AztecAddress[]
}

export class ContextChanged extends Error {
	constructor() {
		super("the wallet context changed")
		this.name = "ContextChanged"
	}
}

class ProveTimeout extends Error {}

const same = (a: Address | null, b: Address) => a !== null && isAddressEqual(a, b)

/** Whether `a` still describes the wallets as they are. */
export function isCurrent(a: Attempt, ctx: LiveContext): boolean {
	return (
		same(ctx.owner, a.owner) &&
		same(ctx.account, a.sender) &&
		ctx.chainId === a.chainId &&
		ctx.deployment === a.deployment &&
		ctx.epoch === a.epoch &&
		ctx.aztecAccounts.includes(a.recipient)
	)
}

export function assertCurrent(a: Attempt, ctx: LiveContext): void {
	if (!isCurrent(a, ctx)) throw new ContextChanged()
}

/**
 * A run the page replaced (another bridge opened, a sign-out) is stopped like a changed context, and
 * so is one whose claim grant was withdrawn: the bridged funds could not be claimed from this page.
 */
function assertLive(st: State, a: Attempt, signal: AbortSignal): void {
	if (signal.aborted || !st.deps.canClaim()) throw new ContextChanged()
	assertCurrent(a, st.deps.context())
}

/**
 * A claim is bound to the context as it stands when the claim starts (after a reload, the current
 * connection), and must still hold right before the Aztec wallet is asked to send.
 */
interface ClaimContext {
	owner: Address
	account: Address | null
	chainId: number
	deployment: string
	epoch: number
	recipient: AztecAddress
}

const claimCurrent = (c: ClaimContext, ctx: LiveContext) =>
	same(ctx.owner, c.owner) &&
	(c.account === null ? ctx.account === null : same(ctx.account, c.account)) &&
	ctx.chainId === c.chainId &&
	ctx.deployment === c.deployment &&
	ctx.epoch === c.epoch &&
	ctx.aztecAccounts.includes(c.recipient)

/**
 * The wallet requests a page still has out, shared by every driver it creates. Signing out closes a
 * session but cannot recall a request its wallet already holds, so the next session's driver must
 * still see it. Memory only: a reload starts empty, and the journal and the chain answer from there.
 */
export interface Outstanding {
	/** Notes with a Submit under way; each leaves when its Submit settles. */
	readonly sends: Set<bigint>
	/** Records with a claim under way, or one the chain dropped or never answered, with its hash when known. */
	readonly claims: Map<string, Hex | null>
}

export const createOutstanding = (): Outstanding => ({ sends: new Set(), claims: new Map() })

export interface DriverDeps {
	outstanding: Outstanding
	session: Session
	deployment: Pick<Deployment, "id" | "chainId">
	timer: Timer
	/** Resolves after the next paint. */
	frame(): Promise<void>
	context(): LiveContext
	/** Whether the wallet granted the claim (requested and granted). */
	canClaim(): boolean
}

export interface SubmitInput {
	note: PoolNoteView
	amount: bigint
	/** As typed or as the connection lists it; parsed here. */
	recipient: string
}

export interface CheckInput {
	note: PoolNoteView
	/** The attempt's recipient, for `recover` once the journal holds no record of the note. */
	recipient: string
}

export type Dispatch = (e: BridgeEvent) => void

interface Flags {
	acceptUncertain?: true
}

interface Binding {
	recipient: AztecAddress
	epoch: number
	at: number
	consumed: boolean
}

/** One driver's memory: the run counter, the preflight binding and which notes may send. */
interface State {
	deps: DriverDeps
	seq: number
	binding: Binding | null
	/** The page's `Outstanding.sends`. */
	active: Set<bigint>
	/** Notes with a transaction pending at the RPC, from the session's answer or the last reconciliation. */
	inFlight: ReadonlySet<bigint>
	/** Notes spent outside this bridge: they never send again from this page. */
	closed: Map<bigint, UiCode>
	/** The page's `Outstanding.claims`. */
	claims: Map<string, Hex | null>
}

/** Why Submit must not start, or `null`. Each refusal happens before any call into the session. */
function submitRefusal(input: SubmitInput, ctx: LiveContext, chainId: number): UiCode | null {
	if (ctx.owner === null) return "SESSION_CLOSED"
	if (ctx.account === null) return "NO_SENDER"
	if (ctx.chainId !== chainId) return "CHAIN_MISMATCH"
	if (isAddressEqual(ctx.account, ctx.owner)) return "SENDER_IS_OWNER"
	const recipient = parseAztecAddress(input.recipient)
	if (recipient === null) return "RECIPIENT_INVALID"
	if (ctx.epoch === null || !ctx.aztecAccounts.includes(recipient)) return "RECIPIENT_NOT_IN_WALLET"
	if (input.note.status !== "approved" || input.note.value === 0n) return "NOTE_NOT_BRIDGEABLE"
	if (input.amount <= 0n || input.amount > input.note.value) return "AMOUNT_INVALID"
	return null
}

const failure = (code: UiCode, during: Failure["during"], extra: Partial<Failure> = {}): BridgeEvent => ({
	type: "failed",
	failure: { code, during, offer: offerFor(code), ...extra },
})

const fresh = (st: State, a: Attempt) =>
	st.binding !== null &&
	!st.binding.consumed &&
	st.binding.recipient === a.recipient &&
	st.binding.epoch === a.epoch &&
	st.deps.timer.now() - st.binding.at <= PREFLIGHT_FRESH_MS

async function runPreflight(st: State, recipient: AztecAddress, epoch: number, dispatch: Dispatch, warm: boolean): Promise<void> {
	st.binding = null
	dispatch({ type: "preflight" })
	await st.deps.session.preflight(recipient, epoch)
	// bridge-core's 10 minutes start at its answer, so a slow warm-up must not make the entry look younger.
	const at = st.deps.timer.now()
	if (warm) await st.deps.session.warmUp()
	st.binding = { recipient, epoch, at, consumed: false }
	dispatch({ type: "preflighted", binding: { recipient, epoch, at } })
}

async function preflight(st: State, rawRecipient: string, dispatch: Dispatch, signal: AbortSignal): Promise<void> {
	const ctx = st.deps.context()
	const recipient = parseAztecAddress(rawRecipient)
	if (recipient === null) return dispatch({ type: "refused", code: "RECIPIENT_INVALID" })
	if (ctx.epoch === null || !ctx.aztecAccounts.includes(recipient)) return dispatch({ type: "refused", code: "RECIPIENT_NOT_IN_WALLET" })
	const epoch = ctx.epoch
	try {
		await runPreflight(st, recipient, epoch, dispatch, true)
	} catch (err) {
		if (!signal.aborted) dispatch(failure(codeOf(err) ?? "UNKNOWN", "preparing"))
		return
	}
	const now = st.deps.context()
	if (!signal.aborted && (now.epoch !== epoch || !now.aztecAccounts.includes(recipient))) {
		st.binding = null
		dispatch(failure("CONTEXT_CHANGED", "preparing"))
	}
}

async function proveWithDeadline(st: State, a: Attempt, signal: AbortSignal): Promise<Proved> {
	const { session, timer } = st.deps
	const stop = new AbortController()
	const deadline = timer.sleep(PROVE_DEADLINE_MS, stop.signal).then((elapsed) => {
		if (elapsed) throw new ProveTimeout()
		return new Promise<never>(() => {})
	})
	// An aborted run cancels its proof too: a hung one would otherwise hold the note and the prover.
	const cancel = () => session.cancelProve()
	signal.addEventListener("abort", cancel, { once: true })
	try {
		return await Promise.race([session.prove(a), deadline])
	} catch (err) {
		if (err instanceof ProveTimeout) session.cancelProve()
		throw err
	} finally {
		signal.removeEventListener("abort", cancel)
		stop.abort()
	}
}

/** The public fields a coded failure carries onto the screen. */
function extraOf(err: unknown): Partial<Failure> {
	const e = (typeof err === "object" && err !== null ? err : {}) as { stale?: Failure["stale"]; l1TxHash?: Failure["l1TxHash"] }
	return { ...(e.stale !== undefined ? { stale: e.stale } : {}), ...(e.l1TxHash ? { l1TxHash: e.l1TxHash } : {}) }
}

const CLOSES: ReadonlySet<UiCode> = new Set(["CONSUMED_ELSEWHERE"])

/** Remembers what a code means for the note's next Submit. */
function remember(st: State, code: UiCode, note: bigint): void {
	if (code === "IN_FLIGHT") st.inFlight = new Set([...st.inFlight, note])
	if (CLOSES.has(code)) st.closed.set(note, code)
	if (code === "PREFLIGHT_REQUIRED") st.binding = null
}

/** What a failed Submit means; nothing here resends. */
function outcome(st: State, err: unknown, a: Attempt, during: Failure["during"], handedOff: boolean): BridgeEvent {
	if (err instanceof ProveTimeout) return failure("PROVE_TIMEOUT", "preparing")
	if (!handedOff && !st.deps.canClaim()) return failure("NOT_GRANTED", during)
	if (!handedOff && !isCurrent(a, st.deps.context())) return failure("CONTEXT_CHANGED", during)
	if (handedOff && isUserRejection(err)) return { type: "declined" }
	// Past the handoff, an error without a code may hide a sent transaction with no hash: UNCERTAIN.
	const code = codeOf(err) ?? (handedOff ? "UNCERTAIN" : during === "preparing" ? "PROVE_FAILED" : "RPC_FAILED")
	remember(st, code, a.note)
	return failure(code, code === "REVERTED" ? "submitted" : during, extraOf(err))
}

function freeze(st: State, input: SubmitInput, ctx: LiveContext): Attempt {
	return Object.freeze({
		seq: ++st.seq,
		owner: ctx.owner as Address,
		sender: ctx.account as Address,
		recipient: parseAztecAddress(input.recipient) as AztecAddress,
		deployment: st.deps.deployment.id,
		chainId: st.deps.deployment.chainId,
		epoch: ctx.epoch as number,
		note: input.note.commitment,
		amount: input.amount,
	})
}

/** Nothing here answers for an uncertain note from memory: its journal and the chain decide, in `priorOutcome` and `Session.submit`. */
function refusalOf(st: State, input: SubmitInput, ctx: LiveContext): UiCode | null {
	const n = input.note.commitment
	const closed = st.closed.get(n)
	if (closed !== undefined) return closed
	if (st.inFlight.has(n)) return "IN_FLIGHT"
	if (!st.deps.canClaim()) return "NOT_GRANTED"
	return submitRefusal(input, ctx, st.deps.deployment.chainId)
}

const PRIOR_CODES: Record<Exclude<PriorKind, "bridge">, UiCode> = {
	"in-flight": "IN_FLIGHT",
	uncertain: "UNCERTAIN",
	consumed: "CONSUMED_ELSEWHERE",
}

/** What the journal and the chain show for a note, on screen: a record as it stands, or why nothing may send. */
function foundEvent(st: State, found: Found, note: bigint): BridgeEvent {
	if (found.kind === "bridge" || found.kind === "closed") return { type: "record", record: found.record }
	const code = PRIOR_CODES[found.kind]
	remember(st, code, note)
	return failure(code, "preparing")
}

/** Without the override, the note's open attempt answers a Submit first. `null`: none is open, so prove and send. */
async function priorOutcome(st: State, a: Attempt): Promise<BridgeEvent | null> {
	try {
		const prior = await priorAttempt(st.deps.session, a.note)
		return prior === null ? null : foundEvent(st, prior, a.note)
	} catch (err) {
		return failure(codeOf(err) ?? "RPC_FAILED", "preparing")
	}
}

/**
 * Check again: what the journal and the chain show for the note, and nothing more. It never proves or
 * sends, whatever it finds; Send again is the one way to send while an attempt may be out. An answer
 * that lands after any Submit has started is dropped, since that Submit owns the screen.
 */
async function check(st: State, input: CheckInput, dispatch: Dispatch, signal: AbortSignal): Promise<BridgeRecordView | null> {
	const n = input.note.commitment
	if (st.active.has(n)) return null
	const recipient = parseAztecAddress(input.recipient)
	if (recipient === null) {
		dispatch({ type: "refused", code: "RECIPIENT_INVALID" })
		return null
	}
	const seq = st.seq
	let event: BridgeEvent
	try {
		event = foundEvent(st, await checkAttempt(st.deps.session, n, recipient), n)
	} catch (err) {
		event = failure(codeOf(err) ?? "RPC_FAILED", "preparing")
	}
	if (signal.aborted || st.seq !== seq) return null
	dispatch(event)
	return event.type === "record" ? event.record : null
}

async function prepareAndProve(st: State, a: Attempt, dispatch: Dispatch, signal: AbortSignal): Promise<Proved> {
	const { deps } = st
	if (!fresh(st, a)) await runPreflight(st, a.recipient, a.epoch, dispatch, false)
	assertLive(st, a, signal)
	dispatch({ type: "proving" })
	await deps.frame()
	await deps.frame()
	assertLive(st, a, signal)
	const proved = await proveWithDeadline(st, a, signal)
	assertLive(st, a, signal)
	return proved
}

async function submit(
	st: State,
	input: SubmitInput,
	dispatch: Dispatch,
	signal: AbortSignal,
	flags: Flags,
): Promise<BridgeRecordView | null> {
	const n = input.note.commitment
	if (st.active.has(n)) return null
	// A replaced run keeps going in the background but never touches the screen it no longer owns.
	const emit: Dispatch = (e) => {
		if (!signal.aborted) dispatch(e)
	}
	const ctx = st.deps.context()
	const refusal = refusalOf(st, input, ctx)
	if (refusal !== null) {
		emit({ type: "refused", code: refusal })
		return null
	}
	st.active.add(n)
	const a = freeze(st, input, ctx)
	emit({ type: "submit", attempt: a })
	let during: Failure["during"] = "preparing"
	let handedOff = false
	const hooks: SubmitHooks = {
		reproving: (code) => emit({ type: "reproving", code }),
		sent: (txHash) => emit({ type: "sent", txHash }),
		// Aborting stops a wallet request only before it starts; one already issued still needs its
		// outcome remembered, so the catch below runs `outcome` for an aborted run too.
		handoff: () => {
			assertLive(st, a, signal)
			handedOff = true
			if (st.binding) st.binding.consumed = true
			during = "submitted"
			emit({ type: "handoff" })
		},
	}
	try {
		const prior = flags.acceptUncertain ? null : await priorOutcome(st, a)
		if (prior !== null) {
			emit(prior)
			return prior.type === "record" ? prior.record : null
		}
		const proved = await prepareAndProve(st, a, emit, signal)
		during = "prepared"
		emit({ type: "proved" })
		const record = await st.deps.session.submit(proved, a, hooks, flags.acceptUncertain ? { acceptUncertain: true } : undefined)
		emit({ type: "record", record })
		return record
	} catch (err) {
		emit(outcome(st, err, a, during, handedOff))
		return null
	} finally {
		st.active.delete(n)
	}
}

async function follow(st: State, record: BridgeRecordView, dispatch: Dispatch, signal: AbortSignal): Promise<void> {
	// The journal still says claimable while a claim is out; the screen must show it pending, not offer it.
	const claimTx = st.claims.get(record.id)
	if (claimTx !== undefined) return signal.aborted ? undefined : dispatch({ type: "claim-pending", txHash: claimTx })
	if (record.step !== "mined" && record.step !== "submitted") return
	try {
		await st.deps.session.waitClaimable(record.id, signal)
		if (!signal.aborted) dispatch({ type: "claimable" })
	} catch (err) {
		if (!signal.aborted) dispatch(failure(codeOf(err) ?? "NOT_CLAIMABLE", "mined"))
	}
}

function claimRefusal(st: State, record: BridgeRecordView, ctx: LiveContext): UiCode | null {
	if (!st.deps.canClaim()) return "NOT_GRANTED"
	if (ctx.owner === null) return "SESSION_CLOSED"
	if (ctx.chainId !== st.deps.deployment.chainId) return "CHAIN_MISMATCH"
	if (ctx.epoch === null || !ctx.aztecAccounts.includes(record.recipient)) return "RECIPIENT_NOT_IN_WALLET"
	return null
}

function claimOutcome(st: State, err: unknown, c: ClaimContext, handedOff: boolean): BridgeEvent {
	if (isUserRejection(err)) return { type: "claim-declined" }
	// Past the handoff, anything but the wallet's no may hide a claim that went out.
	if (handedOff) return { type: "claim-pending", txHash: null }
	if (!st.deps.canClaim()) return failure("NOT_GRANTED", "claiming", { offer: "claim" })
	if (!claimCurrent(c, st.deps.context())) return failure("CONTEXT_CHANGED", "claiming", { offer: "claim" })
	return failure(codeOf(err) ?? "CLAIM_FAILED", "claiming", { offer: "claim" })
}

function sentOutcome(sent: Sent): BridgeEvent {
	if (sent.status === "success") return { type: "claimed" }
	if (sent.status === "dropped") return { type: "claim-pending", txHash: sent.txHash }
	return failure("CLAIM_REVERTED", "claiming", sent.reason ? { reason: sent.reason } : {})
}

async function claim(st: State, record: BridgeRecordView, dispatch: Dispatch, signal: AbortSignal): Promise<void> {
	if (st.claims.has(record.id)) return
	const ctx = st.deps.context()
	const refusal = claimRefusal(st, record, ctx)
	if (refusal !== null) return dispatch({ type: "refused", code: refusal })
	const c: ClaimContext = {
		owner: ctx.owner as Address,
		account: ctx.account,
		chainId: st.deps.deployment.chainId,
		deployment: st.deps.deployment.id,
		epoch: ctx.epoch as number,
		recipient: record.recipient,
	}
	st.claims.set(record.id, null)
	dispatch({ type: "claiming" })
	let handedOff = false
	const handoff = () => {
		if (signal.aborted || !st.deps.canClaim() || !claimCurrent(c, st.deps.context())) throw new ContextChanged()
		handedOff = true
	}
	let event: BridgeEvent
	try {
		event = sentOutcome(await st.deps.session.claim(record.id, { epoch: c.epoch, handoff }))
	} catch (err) {
		event = claimOutcome(st, err, c, handedOff)
	}
	// A pending claim keeps its record blocked: the page never resends it.
	if (event.type === "claim-pending") st.claims.set(record.id, event.txHash)
	else st.claims.delete(record.id)
	if (!signal.aborted) dispatch(event)
}

/**
 * One driver per open session. `submit` freezes an attempt and runs it to a mined record; `follow`
 * waits for it to become claimable (also after a reload); `claim` sends it from its recipient.
 */
export function createBridgeDriver(deps: DriverDeps) {
	const { sends: active, claims } = deps.outstanding
	const st: State = { deps, seq: 0, binding: null, active, inFlight: new Set(), closed: new Map(), claims }
	return {
		/** Preflight and warm-up for the connected recipient, ahead of Submit. */
		preflight: (recipient: string, dispatch: Dispatch, signal: AbortSignal) => preflight(st, recipient, dispatch, signal),
		/** A second call for a note whose Submit is under way is ignored. */
		submit: (input: SubmitInput, dispatch: Dispatch, signal: AbortSignal, flags: Flags = {}) =>
			submit(st, input, dispatch, signal, flags),
		/** Reads only; the record when it found one to follow. */
		check: (input: CheckInput, dispatch: Dispatch, signal: AbortSignal) => check(st, input, dispatch, signal),
		follow: (record: BridgeRecordView, dispatch: Dispatch, signal: AbortSignal) => follow(st, record, dispatch, signal),
		claim: (record: BridgeRecordView, dispatch: Dispatch, signal: AbortSignal) => claim(st, record, dispatch, signal),
		/** The notes with a Submit under way here, which reconciliation must not take for unconfirmed. */
		submitting: (): ReadonlySet<bigint> => new Set(st.active),
		/** The notes reconciliation found pending at the RPC; each refuses a Submit until it leaves the set. */
		hold: (notes: ReadonlySet<bigint>) => {
			st.inFlight = notes
		},
	}
}

export type BridgeDriver = ReturnType<typeof createBridgeDriver>
