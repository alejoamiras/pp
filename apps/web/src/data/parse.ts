/**
 * Parsers for values that cross a trust boundary: typed input, wallet answers, contract views. Each
 * returns `null` (or a reason) instead of throwing, so a hostile value cannot crash a screen.
 */
import { type Address, checksumAddress, isAddressEqual } from "viem"
import type { LabelBalance } from "./ports"
import type { AztecAddress, Origin } from "./stack-types"

/** The BN254 scalar field modulus: Aztec addresses and labels are elements of this field. */
export const BN254_P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

const FIELD_HEX = /^0x[0-9a-fA-F]{64}$/
const ETH_HEX = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

/** Reads `toString()` of an address-like object too; one that throws is no address. */
function textOf(value: unknown): string | null {
	if (typeof value === "string") return value
	if (typeof value !== "object" || value === null) return null
	try {
		const text: unknown = (value as { toString(): unknown }).toString()
		return typeof text === "string" ? text : null
	} catch {
		return null
	}
}

/**
 * A canonical Aztec address: 0x and 64 hex digits, below the field modulus, lower-cased. Syntax only:
 * whether it can receive notes is `isAztecPoint`.
 */
export function parseAztecAddress(value: unknown): AztecAddress | null {
	const text = textOf(value)?.trim()
	if (!text || !FIELD_HEX.test(text)) return null
	if (BigInt(text) >= BN254_P) return null
	return text.toLowerCase() as AztecAddress
}

function powMod(base: bigint, exponent: bigint, modulus: bigint): bigint {
	let result = 1n
	let b = base % modulus
	for (let e = exponent; e > 0n; e >>= 1n) {
		if (e & 1n) result = (result * b) % modulus
		b = (b * b) % modulus
	}
	return result
}

/**
 * Whether notes sent to `a` can ever be spent: an address is the x of a Grumpkin point
 * (y² = x³ − 17 over the BN254 scalar field), so any other x, and zero, is refused. Euler's criterion
 * decides it without aztec.js's address class, which would pull bb.js (about 11 MB) into the bundle.
 */
export function isAztecPoint(a: AztecAddress): boolean {
	const x = BigInt(a)
	if (x === 0n) return false
	const ySquared = (((((x * x) % BN254_P) * x) % BN254_P) - 17n + BN254_P) % BN254_P
	return ySquared === 0n || powMod(ySquared, (BN254_P - 1n) / 2n, BN254_P) === 1n
}

export type PayeeRefusal = "format" | "checksum" | "zero" | "portal"

/**
 * An Ethereum payee typed by the user. Only the exact EIP-55 spelling passes, so a mistyped character
 * cannot slip through; an all-lower-case address carries no checksum and is refused too. The zero
 * address and the portal are refused: the portal pays neither, and the burn would strand the funds.
 */
export function parsePayee(value: unknown, portal: Address): { ok: true; payee: Address } | { ok: false; reason: PayeeRefusal } {
	const text = textOf(value)?.trim() ?? ""
	if (!ETH_HEX.test(text)) return { ok: false, reason: "format" }
	const address = text as Address
	if (checksumAddress(address) !== address) return { ok: false, reason: "checksum" }
	if (isAddressEqual(address, ZERO_ADDRESS)) return { ok: false, reason: "zero" }
	if (isAddressEqual(address, portal)) return { ok: false, reason: "portal" }
	return { ok: true, payee: address }
}

/** A label as a field element, from a contract view or the wallet: a bigint or decimal/hex text below p. */
export function parseLabel(value: unknown): bigint | null {
	let n: bigint
	if (typeof value === "bigint") n = value
	else if (typeof value === "string" && /^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(value)) n = BigInt(value)
	else return null
	return n >= 0n && n < BN254_P ? n : null
}

/** A note's origin as a view returns it (u8): only 0 or 1. */
export function parseOrigin(value: unknown): Origin | null {
	if (value === 0 || value === 0n) return 0
	if (value === 1 || value === 1n) return 1
	return null
}

/** One `private_balances_by_label` row, `(label, origin, balance)`, as a wallet answers it. */
export function parseBalanceRow(row: readonly unknown[]): LabelBalance | null {
	const [label, origin, balance] = [parseLabel(row[0]), parseOrigin(row[1]), parseU128(row[2])]
	return label === null || origin === null || balance === null ? null : { label, origin, balance }
}

const DECIMAL = /^(\d{1,39})(?:\.(\d*))?$/

/**
 * A typed amount in base units: plain decimal digits with at most `decimals` fraction digits, no sign,
 * exponent or grouping. Zero parses; the caller decides the range.
 */
export function parseAmount(text: string, decimals: number): bigint | null {
	const m = DECIMAL.exec(text.trim())
	if (!m) return null
	const fraction = m[2] ?? ""
	if (fraction.length > decimals) return null
	return BigInt(m[1] ?? "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")
}

/** A u128 amount from a view; anything else is no amount. */
export function parseU128(value: unknown): bigint | null {
	const n = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null
	return n !== null && n >= 0n && n < 1n << 128n ? n : null
}
