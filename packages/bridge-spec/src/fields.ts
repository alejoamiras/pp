/** BN254 scalar field modulus: every word of every payload is below it. */
export const BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
export const U128_MAX = (1n << 128n) - 1n
export const U160_LIMIT = 1n << 160n

/** One name per rule in all three languages: the Solidity error, this code and the Noir assert message. */
export type SpecErrorCode =
	| "SecretHashOutOfRange"
	| "FieldOutOfRange"
	| "AmountOutOfRange"
	| "ZeroPayee"
	| "PayeeOutOfRange"
	| "LabelOutOfRange"
	| "DepthOutOfRange"
	| "IndexOutOfRange"
	| "SiblingOutOfRange"
	| "ZeroRoot"
	| "NotMember"
	| "TreeTooLarge"
	| "EmptyTree"
	| "InvalidSignature"
	| "InvalidAddress"
	| "InvalidKey"

/**
 * A rejected input. For a secret input (signature, claim key, salt, spent commitment, birth secret)
 * `value` is absent and nothing in the message or cause carries the input's bytes.
 */
export class SpecRangeError extends Error {
	readonly code: SpecErrorCode
	readonly field: string
	readonly value?: bigint | string

	constructor(code: SpecErrorCode, field: string, value?: bigint | string) {
		super(
			value === undefined
				? `${code}: ${field}`
				: `${code}: ${field} = ${typeof value === "bigint" ? `0x${value.toString(16)}` : value}`,
		)
		this.name = "SpecRangeError"
		this.code = code
		this.field = field
		if (value !== undefined) this.value = value
	}
}

/** Requires an integer in [min, max]; a secret field reports no value. */
export function assertRange(v: bigint, min: bigint, max: bigint, code: SpecErrorCode, field: string, secret = false): bigint {
	if (typeof v !== "bigint" || v < min || v > max) throw new SpecRangeError(code, field, secret ? undefined : String(v))
	return v
}

export const assertField = (v: bigint, field: string, secret = false): bigint =>
	assertRange(v, 0n, BN254_P - 1n, "FieldOutOfRange", field, secret)

const HEX = /^0x[0-9a-fA-F]*$/

/** Decodes 0x-prefixed hex of exactly `bytes` bytes, or returns undefined. */
export function hexBytes(hex: string, bytes: number): Uint8Array | undefined {
	if (typeof hex !== "string" || !HEX.test(hex) || hex.length !== 2 + 2 * bytes) return undefined
	const out = new Uint8Array(bytes)
	for (let i = 0; i < bytes; i++) out[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16)
	return out
}

export function toHex(bytes: Uint8Array): `0x${string}` {
	let s = "0x"
	for (const b of bytes) s += b.toString(16).padStart(2, "0")
	return s as `0x${string}`
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
	let v = 0n
	for (const b of bytes) v = (v << 8n) | BigInt(b)
	return v
}

/** A 32-byte big-endian word; callers have already range-checked `v`. */
export function word(v: bigint): Uint8Array {
	const out = new Uint8Array(32)
	let x = v
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(x & 0xffn)
		x >>= 8n
	}
	return out
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.length
	}
	return out
}
