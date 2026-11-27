/**
 * Error codes to the sentences the page shows. Only these sentences reach the screen: a lower error's
 * message, a wallet's wording or a revert string is never displayed.
 */
import type { BridgeClientErrorCode, StaleRootCode } from "./stack-types"
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
	| "WITHDRAW_REVERTED"
	| "TX_DROPPED"
	| "TX_UNCONFIRMED"
	| "TX_UNSETTLED"
	| "TX_UNSETTLED_NO_HASH"
	| "WAIT_FINALITY"
	| "TX_BUSY"
	| "BRIDGE_UNAVAILABLE"
	| AllowListCode
	| "LABEL_ABSENT"
	| "OVER_NOTE_CAP"
	| "OVER_PUBLIC_BALANCE"
	| "LIST_STALE"
	| "UNKNOWN"

/**
 * Why a label could not be checked. A list that timed out, did not match the chain, was larger than
 * any list can be or whose check was stopped stays failed until a manual Check again; an unavailable
 * one is read again on the next refresh.
 */
export type AllowListCode = "LIST_TIMEOUT" | "LIST_MISMATCH" | "LIST_OVERSIZED" | "LIST_CANCELLED" | "LIST_UNAVAILABLE"

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
	WITHDRAW_REVERTED:
		"The withdrawal reverted: the fee was paid; your notes are safe. Sending, unshielding and withdrawing wait until that transaction is final.",
	TX_DROPPED:
		"Aztec has not included the transaction yet, and it may still be. The page will not send it again, and sending from this account waits until Refresh reads it included.",
	TX_UNCONFIRMED:
		"Your wallet sent the transaction, but the page could not read whether it landed. The page will not send it again, and sending from this account waits until Refresh reads it included.",
	TX_UNSETTLED:
		"Your last send from this account may still land on Aztec. Sending waits until Refresh reads that transaction included or reverted, so the same funds cannot go out twice.",
	TX_UNSETTLED_NO_HASH:
		"Your last send from this account may have gone out, and the page has no transaction to check. Sending stays closed until you reload; check your wallet's activity first, or the same funds can go out twice.",
	WAIT_FINALITY:
		"Send, Unshield and Withdraw wait for finality: the reverted transaction's block must be proven first. Refresh to check.",
	TX_BUSY: "Wait for your last Aztec transaction to finish.",
	BRIDGE_UNAVAILABLE: "Bridging is not available in this version of the app yet. Your notes stay in the pool.",
	LIST_TIMEOUT: "The allow list took too long to download, so no label was checked. Check again.",
	LIST_MISMATCH: "The allow list the server sent does not match the one on chain, so no label was checked against it.",
	LIST_OVERSIZED: "The allow list the server sent is larger than any allow list can be, so it was not read.",
	LIST_CANCELLED: "You stopped the allow-list check. Check again when you are ready.",
	LIST_UNAVAILABLE: "The allow list could not be read. The page reads it again on the next refresh.",
	LABEL_ABSENT: "This label is not in the latest allow list, so nothing was sent.",
	OVER_NOTE_CAP:
		"This label's notes changed, and one transaction can no longer spend that amount, so nothing was sent. Check the amount and try again.",
	LIST_STALE: "The allow list is out of date, so nothing was sent. Wait for its next post.",
	OVER_PUBLIC_BALANCE: "Your public balance no longer covers that amount, so nothing was sent. Refresh, check the amount and try again.",
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

/**
 * The contract assertions a transaction can revert on after it was sent, each with the page's own
 * sentence. The token's unshield finishes in a public step that re-reads the allow list; nothing
 * else the page sends has a public step that can fail.
 */
const REVERTS = [
	["roots changed", "The allow list changed before the transaction landed. Check the label again, then retry."],
	["current root too old", "The allow list grew too old before the transaction landed. Wait for its next post, then retry."],
] as const

export type KnownRevert = (typeof REVERTS)[number][0]

/**
 * The page's sentence for a revert reason that names one of the listed assertions, else `null`. A
 * chain's reason is untrusted text: it is matched, never shown.
 */
export function revertCopy(reason: string | undefined): string | null {
	if (reason === undefined) return null
	return REVERTS.find(([assertion]) => reason.includes(assertion))?.[1] ?? null
}

/** Follows `cause` a few levels: wallets and viem wrap the code that matters. */
function* chain(err: unknown): Generator<Record<string, unknown>> {
	let current = err
	for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
		yield current as Record<string, unknown>
		current = (current as { cause?: unknown }).cause
	}
}

const REJECTION_WORDS = /rejected by user|user rejected|user denied|denied by user|user cancel/i

/**
 * An explicit no from the user (EIP-1193 4001, viem's rejection, the wallet's wording); never an outage.
 * Only for a failure before a send was handed over: past the handoff, wording is no proof, so
 * `isWalletRefusal` decides.
 */
export function isUserRejection(err: unknown): boolean {
	for (const e of chain(err)) {
		if (e.code === 4001 || e.name === "UserRejectedRequestError") return true
		if (typeof e.message === "string" && REJECTION_WORDS.test(e.message)) return true
	}
	return false
}

/** wallet-sdk 6.0.0's extension transport throws each wallet error as `new Error(JSON.stringify(error))`. */
function sdkEnvelope(message: unknown): Record<string, unknown> | null {
	if (typeof message !== "string" || !message.startsWith("{")) return null
	try {
		const parsed: unknown = JSON.parse(message)
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

/**
 * The refusals the page trusts once a send was handed to the wallet, where any other failure may hide
 * a broadcast. Each is a typed signal or a tested wallet's exact error, read on the thrown error itself,
 * never a phrase inside a message. The kit's test wallet has no decline, so it has no entry: an injected
 * failure there holds like any other.
 */
export const REFUSAL_SHAPES: readonly { readonly wallet: string; matches(e: Record<string, unknown>): boolean }[] = [
	{ wallet: "EIP-1193 provider (4001)", matches: (e) => e.code === 4001 },
	{ wallet: "viem", matches: (e) => e.name === "UserRejectedRequestError" },
	{
		// Measured on wallet v1.3.0's Reject; its other 4001s (a cancelled job) are not shown to send nothing.
		// Fields the wallet adds are ignored, so a new one does not turn every decline into a hold.
		wallet: "wallet-sdk 6.0.0 extension (released wallet)",
		matches: (e) => {
			const env = sdkEnvelope(e.message)
			const data = env?.data
			if (env?.code !== 4001 || env.message !== "User rejected" || typeof data !== "object" || data === null) return false
			const d = data as Record<string, unknown>
			return d.walletErrorCode === "USER_REJECTED" && typeof d.walletTraceId === "string"
		},
	},
]

/** Whether `err` is a refusal past the handoff: one of `REFUSAL_SHAPES`, else the send may have gone out. */
export function isWalletRefusal(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false
	const e = err as Record<string, unknown>
	return REFUSAL_SHAPES.some((s) => s.matches(e))
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

/** Why a label could not be checked; `retryInMs` is how long a manual Check again must wait. */
export class AllowListError extends Error {
	constructor(
		readonly code: AllowListCode,
		readonly retryInMs = 0,
	) {
		super(code)
		this.name = "AllowListError"
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
