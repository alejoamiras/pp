import type { Hash } from "viem"

/** pool-client's spend checks plus the bridge's own; `check` names the first one a spend failed. */
export type SpendCheckName =
	| "shape"
	| "request"
	| "params"
	| "public"
	| "nullifier"
	| "change"
	| "context"
	| "salt"
	| "secretHash"
	| "data"
	| "processor"
	| "asset"
	| "recipient"

export type StaleRootCode = "STATE_ROOT_STALE" | "KEYSTORE_ROOT_STALE" | "ASP_ROOT_STALE"

/** Closed set: a new failure mode gets a new code here, never a free-text message. */
export type BridgeClientErrorCode =
	| "FORGED_SESSION"
	| "SESSION_DEPLOYMENT_MISMATCH"
	| "DEPLOYMENT_MISMATCH"
	| "CHAIN_MISMATCH"
	| "RECIPIENT_INVALID"
	| "RECIPIENT_NOT_IN_WALLET"
	| "FEE_PATH_FAILED"
	| "PREFLIGHT_REQUIRED"
	| "SPEND_MISMATCH"
	| "SENDER_IS_OWNER"
	| "IN_FLIGHT"
	| "UNCERTAIN"
	| "STALE"
	| "SIMULATION_REVERTED"
	| "REVERTED"
	| "CONSUMED_ELSEWHERE"
	| "NOTE_NOT_FOUND"
	| "OPENING_MISMATCH"
	| "NOT_CLAIMABLE"
	| "EXIT_NOT_READY"
	| "STAGE_UNSUPPORTED"
	| "TICKET_NOT_FOUND"
	| "NO_EXACT_CHUNKS"
	| "RPC_FAILED"
	| "RPC_INCONSISTENT"

export type BridgeClientErrorDetail = {
	check?: SpendCheckName
	stale?: StaleRootCode | null
	/** A decoded revert's error name. */
	revert?: string
	/** The lower layer's error code or class name. */
	source?: string
	l1TxHash?: Hash
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Every failure the bridge client reports. The message is built from the code and the detail
 * fields only, and `source`/`revert` must be identifiers, so no key, salt, opening, argument or
 * lower-layer message can reach a log through this type. It never carries a `cause`.
 */
export class BridgeClientError extends Error {
	readonly code: BridgeClientErrorCode
	readonly check?: SpendCheckName
	readonly stale?: StaleRootCode | null
	readonly revert?: string
	readonly source?: string
	readonly l1TxHash?: Hash

	constructor(code: BridgeClientErrorCode, detail: BridgeClientErrorDetail = {}) {
		for (const field of ["revert", "source"] as const) {
			const value = detail[field]
			if (value !== undefined && !IDENTIFIER.test(value)) throw new TypeError(`BridgeClientError.${field} must be an identifier`)
		}
		const parts = Object.entries(detail).filter(([, v]) => v !== undefined)
		super(parts.length === 0 ? code : `${code} (${parts.map(([k, v]) => `${k}=${String(v)}`).join(", ")})`)
		this.name = "BridgeClientError"
		this.code = code
		if (detail.check !== undefined) this.check = detail.check
		if (detail.stale !== undefined) this.stale = detail.stale
		if (detail.revert !== undefined) this.revert = detail.revert
		if (detail.source !== undefined) this.source = detail.source
		if (detail.l1TxHash !== undefined) this.l1TxHash = detail.l1TxHash
	}
}

export const isBridgeClientError = (e: unknown): e is BridgeClientError => e instanceof BridgeClientError
