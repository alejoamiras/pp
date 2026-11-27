import type { Hash } from "viem"

const SPEND_CHECKS = [
	"shape",
	"request",
	"params",
	"public",
	"nullifier",
	"change",
	"context",
	"salt",
	"secretHash",
	"data",
	"processor",
	"asset",
	"recipient",
] as const

/** pool-client's spend checks plus the bridge's own; `check` names the first one a spend failed. */
export type SpendCheckName = (typeof SPEND_CHECKS)[number]

const STALE_CODES = ["STATE_ROOT_STALE", "KEYSTORE_ROOT_STALE", "ASP_ROOT_STALE"] as const

export type StaleRootCode = (typeof STALE_CODES)[number]

const ERROR_CODES = [
	"FORGED_SESSION",
	"SESSION_DEPLOYMENT_MISMATCH",
	"DEPLOYMENT_MISMATCH",
	"CHAIN_MISMATCH",
	"RECIPIENT_INVALID",
	"RECIPIENT_NOT_IN_WALLET",
	"FEE_PATH_FAILED",
	"PREFLIGHT_REQUIRED",
	"SPEND_MISMATCH",
	"SENDER_IS_OWNER",
	"IN_FLIGHT",
	"UNCERTAIN",
	"STALE",
	"SIMULATION_REVERTED",
	"REVERTED",
	"CONSUMED_ELSEWHERE",
	"NOTE_NOT_FOUND",
	"OPENING_MISMATCH",
	"NOT_CLAIMABLE",
	"EXIT_NOT_READY",
	"STAGE_UNSUPPORTED",
	"TICKET_NOT_FOUND",
	"NO_EXACT_CHUNKS",
	"RPC_FAILED",
	"RPC_INCONSISTENT",
] as const

/** Closed set: a new failure mode gets a new code here, never a free-text message. */
export type BridgeClientErrorCode = (typeof ERROR_CODES)[number]

export type BridgeClientErrorDetail = {
	check?: SpendCheckName
	stale?: StaleRootCode | null
	/** A decoded revert's error name. */
	revert?: string
	/** The lower layer's error code or class name. */
	source?: string
	l1TxHash?: Hash
}

const DETAIL_FIELDS = ["check", "stale", "revert", "source", "l1TxHash"] as const satisfies readonly (keyof BridgeClientErrorDetail)[]

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HASH = /^0x[0-9a-fA-F]{64}$/

const oneOf = (set: readonly string[]) => (v: unknown) => typeof v === "string" && set.includes(v)
const matches = (re: RegExp) => (v: unknown) => typeof v === "string" && re.test(v)

/** What each detail field may hold at runtime; the types alone do not stop a caller passing more. */
const VALID: Record<(typeof DETAIL_FIELDS)[number], (v: unknown) => boolean> = {
	check: oneOf(SPEND_CHECKS),
	stale: (v) => v === null || oneOf(STALE_CODES)(v),
	revert: matches(IDENTIFIER),
	source: matches(IDENTIFIER),
	l1TxHash: matches(HASH),
}

function assertValid(code: unknown, detail: BridgeClientErrorDetail): void {
	if (!oneOf(ERROR_CODES)(code)) throw new TypeError("BridgeClientError.code must be a known code")
	for (const k of DETAIL_FIELDS)
		if (detail[k] !== undefined && !VALID[k](detail[k])) throw new TypeError(`BridgeClientError.${k} is not allowed here`)
}

/**
 * Every failure the bridge client reports. The message is built from the code and the known detail
 * fields only, each validated (`source`/`revert` must be identifiers), so no key, salt, opening,
 * argument or lower-layer message can reach a log through this type. It never carries a `cause`.
 */
export class BridgeClientError extends Error {
	readonly code: BridgeClientErrorCode
	readonly check?: SpendCheckName
	readonly stale?: StaleRootCode | null
	readonly revert?: string
	readonly source?: string
	readonly l1TxHash?: Hash

	constructor(code: BridgeClientErrorCode, detail: BridgeClientErrorDetail = {}) {
		assertValid(code, detail)
		const parts = DETAIL_FIELDS.filter((k) => detail[k] !== undefined).map((k) => `${k}=${String(detail[k])}`)
		super(parts.length === 0 ? code : `${code} (${parts.join(", ")})`)
		this.name = "BridgeClientError"
		this.code = code
		for (const k of DETAIL_FIELDS) if (detail[k] !== undefined) Object.assign(this, { [k]: detail[k] })
	}
}

/** A copy built only from the fields this type allows, each re-validated; anything else on `e` is dropped. */
export function rebuildError(e: BridgeClientError): BridgeClientError {
	const detail: BridgeClientErrorDetail = {}
	for (const k of DETAIL_FIELDS) if (e[k] !== undefined) Object.assign(detail, { [k]: e[k] })
	try {
		return new BridgeClientError(e.code, detail)
	} catch {
		return new BridgeClientError("RPC_FAILED", { source: "BridgeClientError" })
	}
}

export const isBridgeClientError = (e: unknown): e is BridgeClientError => e instanceof BridgeClientError

export const isSpendCheckName = (v: unknown): v is SpendCheckName => oneOf(SPEND_CHECKS)(v)
