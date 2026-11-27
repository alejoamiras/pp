export type PoolClientErrorCode =
	| "SIGNATURE_INVALID"
	| "CHAIN_MISMATCH"
	| "STATE_ROOT_STALE"
	| "KEYSTORE_ROOT_STALE"
	| "ASP_ROOT_STALE"
	| "NOTE_NOT_FOUND"
	| "NOTE_NOT_APPROVED"
	| "AMOUNT_OUT_OF_RANGE"
	| "ASSET_MISMATCH"
	| "ARTIFACT_MISMATCH"
	| "SPEND_CHECK_FAILED"
	| "NULLIFIER_NOT_FOUND"

export type SpendCheck = "shape" | "request" | "params" | "public" | "nullifier" | "change" | "context"

export type ArtifactFile = "wasm" | "provingKey" | "verificationKey"

export type PoolClientErrorDetail = { check?: SpendCheck; circuit?: string; file?: ArtifactFile }

/** Messages never carry the signature or key material, so callers may log them. */
export class PoolClientError extends Error {
	readonly code: PoolClientErrorCode
	readonly check?: SpendCheck
	readonly circuit?: string
	readonly file?: ArtifactFile

	constructor(code: PoolClientErrorCode, message: string, detail: PoolClientErrorDetail = {}) {
		super(`${code}: ${message}`)
		this.name = "PoolClientError"
		this.code = code
		if (detail.check !== undefined) this.check = detail.check
		if (detail.circuit !== undefined) this.circuit = detail.circuit
		if (detail.file !== undefined) this.file = detail.file
	}
}
