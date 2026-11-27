/**
 * Error codes to the sentences the page shows. Only these sentences reach the screen: a lower error's
 * message, a wallet's wording or a revert string is never displayed.
 */
import type { BridgeClientErrorCode, StaleRootCode } from "./a7"
import type { PayeeRefusal } from "./parse"

/** Outcomes the app names itself, beside bridge-core's closed set. */
export type AppCode =
	| "PROVE_TIMEOUT"
	| "PROVE_FAILED"
	| "CONTEXT_CHANGED"
	| "WALLET_REJECTED"
	| "CLAIM_REVERTED"
	| "CLAIM_FAILED"
	| "NOT_GRANTED"
	| "AMOUNT_INVALID"
	| "NOTE_NOT_BRIDGEABLE"
	| "PAYEE_INVALID"
	| "SESSION_CLOSED"
	| "NO_SENDER"
	| "TX_REVERTED"
	| "UNSHIELD_REVERTED"
	| "TX_DROPPED"
	| "WAIT_FINALITY"
	| "TX_BUSY"
	| "UNKNOWN"

export type UiCode = BridgeClientErrorCode | AppCode

const MESSAGES: Record<UiCode, string> = {
	FORGED_SESSION: "This sign-in is no longer valid. Sign in with Ethereum again.",
	SESSION_DEPLOYMENT_MISMATCH: "This sign-in belongs to another deployment. Sign in with Ethereum again.",
	DEPLOYMENT_MISMATCH: "The bridge on chain does not match this app's deployment. Reload the page.",
	CHAIN_MISMATCH: "Your Ethereum wallet is on another network. Switch it to this app's network, then try again.",
	RECIPIENT_INVALID: "That Aztec address cannot receive funds.",
	RECIPIENT_NOT_IN_WALLET: "That Aztec account is not in the connected wallet. Connect the wallet that holds it.",
	FEE_PATH_FAILED: "Your Aztec account cannot pay for the claim yet. Try again in a moment.",
	PREFLIGHT_REQUIRED: "The pre-check expired; nothing was sent. Run it again.",
	SPEND_MISMATCH: "The prepared spend failed its checks, so nothing was sent.",
	SENDER_IS_OWNER: "Switch your Ethereum wallet to a separate account: sending from the pool owner's address links it to this bridge.",
	IN_FLIGHT: "Your earlier transaction for this note is waiting to be mined. Wait for it; the page sends nothing more meanwhile.",
	UNCERTAIN: "This page could not confirm whether your wallet sent the earlier transaction for this note.",
	STALE: "The pool kept changing while proving; nothing was sent. Prove again.",
	SIMULATION_REVERTED: "The bridge would fail on Ethereum, so nothing was sent.",
	REVERTED: "The Ethereum transaction reverted; your note is unspent. Prove again to retry.",
	CONSUMED_ELSEWHERE: "This note was spent by another bridge or outside the bridge.",
	NOTE_NOT_FOUND: "This note is not in your pool account.",
	OPENING_MISMATCH: "The note does not match the bridge record, so nothing was claimed.",
	NOT_CLAIMABLE: "This bridge cannot be claimed.",
	EXIT_NOT_READY: "This exit is still waiting for its epoch proof.",
	STAGE_UNSUPPORTED: "This deployment does not support that action yet.",
	TICKET_NOT_FOUND: "That exit is not on chain.",
	NO_EXACT_CHUNKS: "That amount is not a sum of whole notes. Pick one of the listed amounts.",
	RPC_FAILED: "A network request failed. Try again.",
	RPC_INCONSISTENT: "The network gave inconsistent answers. Wait a moment, then reload.",
	PROVE_TIMEOUT: "Proving took too long; nothing was sent.",
	PROVE_FAILED: "The proof could not be made; nothing was sent.",
	CONTEXT_CHANGED: "Your wallet changed; nothing was sent.",
	WALLET_REJECTED: "The wallet declined; nothing was sent.",
	CLAIM_REVERTED: "The claim reverted on Aztec.",
	CLAIM_FAILED: "The claim did not go through. Try again.",
	NOT_GRANTED: "Your Aztec wallet did not allow this action. Connect again and allow it.",
	AMOUNT_INVALID: "Enter an amount above zero and at most the note's value.",
	NOTE_NOT_BRIDGEABLE: "Only approved notes with a value can be bridged.",
	PAYEE_INVALID: "That payee cannot receive an exit: use a checksummed Ethereum address that is neither zero nor the portal.",
	SESSION_CLOSED: "Sign in with Ethereum first.",
	NO_SENDER: "Connect your Ethereum wallet first.",
	TX_REVERTED: "The transaction reverted on Aztec. Refresh your balances, then try again.",
	UNSHIELD_REVERTED:
		"The unshield reverted: the fee was paid; your notes are safe. Sending and unshielding wait until that transaction is final.",
	TX_DROPPED: "Aztec has not included the transaction yet. The page will not send it again; refresh your balances before you retry.",
	WAIT_FINALITY: "Send and Unshield wait for finality: the reverted unshield must be final first (chain time). Refresh to check.",
	TX_BUSY: "Wait for your last Aztec transaction to finish.",
	UNKNOWN: "Something went wrong, and we can't tell whether anything was sent. Reload to check.",
}

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(MESSAGES))

export const messageOf = (code: UiCode): string => MESSAGES[code]

/** Why a typed payee is refused, each with what to type instead. */
export const PAYEE_MESSAGES: Record<PayeeRefusal, string> = {
	format: "Enter an Ethereum address: 0x followed by 40 hex digits.",
	checksum: "Type the address with its exact capitals (its checksum), so a typo cannot slip through. Copy it from your wallet.",
	zero: "The zero address cannot receive an exit. Enter an address you control.",
	portal: "The portal cannot receive an exit: the funds would be stranded. Enter an address you control.",
}

export const RECIPIENT_MESSAGE = "Enter an Aztec address: 0x followed by 64 hex digits."

/** The worst case of sending again after `UNCERTAIN`, said before the button. */
export const UNCERTAIN_WORST_CASE = "A note can be spent only once, so if both transactions go out, one fails and costs gas only."

/** Which root an internal re-proof follows, in the page's words. */
export const ROOT_NAMES: Record<StaleRootCode, string> = {
	STATE_ROOT_STALE: "pool state",
	KEYSTORE_ROOT_STALE: "keystore",
	ASP_ROOT_STALE: "allow list",
}

export const reprovingMessage = (code: StaleRootCode): string => `A root changed (${ROOT_NAMES[code]}); proving again.`

/** Follows `cause` a few levels: wallets and viem wrap the code that matters. */
function* chain(err: unknown): Generator<Record<string, unknown>> {
	let current = err
	for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
		yield current as Record<string, unknown>
		current = (current as { cause?: unknown }).cause
	}
}

const REJECTION_WORDS = /rejected by user|user rejected|user denied|denied by user|user cancel/i

/** An explicit no from the user (EIP-1193 4001, viem's rejection, the wallet's wording); never an outage. */
export function isUserRejection(err: unknown): boolean {
	for (const e of chain(err)) {
		if (e.code === 4001 || e.name === "UserRejectedRequestError") return true
		if (typeof e.message === "string" && REJECTION_WORDS.test(e.message)) return true
	}
	return false
}

/** The EIP-1193 provider code in `err`'s chain: 4001, 4100, 4200, 4900 or 4901. */
export function providerCode(err: unknown): 4001 | 4100 | 4200 | 4900 | 4901 | null {
	for (const e of chain(err)) {
		const c = e.code
		if (c === 4001 || c === 4100 || c === 4200 || c === 4900 || c === 4901) return c
	}
	return null
}

/** A code from the closed set, read structurally so a stack adapter's real error class passes too. */
export function codeOf(err: unknown): UiCode | null {
	if (typeof err !== "object" || err === null) return null
	const code = (err as { code?: unknown }).code
	return typeof code === "string" && KNOWN_CODES.has(code) ? (code as UiCode) : null
}

/** A coded failure shaped like bridge-core's `BridgeClientError` (no `cause`, no lower message); fixtures throw it. */
export class BridgeFailure extends Error {
	readonly stale?: StaleRootCode | null
	readonly l1TxHash?: `0x${string}`
	constructor(
		readonly code: UiCode,
		extra: { stale?: StaleRootCode | null; l1TxHash?: `0x${string}` } = {},
	) {
		super(code)
		this.name = "BridgeFailure"
		if (extra.stale !== undefined) this.stale = extra.stale
		if (extra.l1TxHash !== undefined) this.l1TxHash = extra.l1TxHash
	}
}

/** An EIP-1193 provider error. */
export class ProviderError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: { reason: string },
	) {
		super(message)
		this.name = "ProviderRpcError"
	}
}
