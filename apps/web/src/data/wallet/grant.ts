/**
 * Reads a wallet's capability answer against the app's own request. Both sides carry the same shapes,
 * so one reader flattens either; the answer is wallet-controlled input throughout.
 */
import type { AztecAddress } from "../a7"
import { parseAztecAddress } from "../parse"
import type { Grant } from "./types"

/** Bound on the granted list: wallet-controlled input. */
export const MAX_GRANTED_ACCOUNTS = 16
const MAX_CONTRACTS = 64
/** Overflow can only shrink a grant: a requested scope missing from the answer reads as a refusal. */
const MAX_SCOPE_ENTRIES = 1024
const WILDCARD = "*"

export type ScopeBucket = "transaction" | "simulation.transactions" | "simulation.utilities"

/** The one spelling of a function scope, shared by the request, the answer and the action table. */
export function scopeKey(bucket: ScopeBucket, contract: AztecAddress, fn: string): string {
	return `${bucket}|${contract}|${fn}`
}

const contractOfKey = (key: string) => key.split("|")[1] ?? ""

interface Side {
	contracts: AztecAddress[]
	scopes: Set<string>
	wildcard: boolean
}

const fieldOf = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined

function readContracts(value: unknown, out: Side): void {
	if (value === WILDCARD) out.wildcard = true
	if (!Array.isArray(value)) return
	for (const entry of value.slice(0, MAX_CONTRACTS)) {
		const address = parseAztecAddress(entry)
		if (address !== null && !out.contracts.includes(address)) out.contracts.push(address)
	}
}

function readScope(scope: unknown, bucket: ScopeBucket, out: Side): void {
	if (scope === WILDCARD) out.wildcard = true
	if (!Array.isArray(scope)) return
	for (const pattern of scope) {
		if (out.scopes.size >= MAX_SCOPE_ENTRIES) return
		const contract = fieldOf(pattern, "contract")
		const fn = fieldOf(pattern, "function")
		if (contract === WILDCARD || fn === WILDCARD) {
			out.wildcard = true
			return
		}
		const address = parseAztecAddress(contract)
		if (address !== null && typeof fn === "string") out.scopes.add(scopeKey(bucket, address, fn))
	}
}

function readSide(list: unknown): Side {
	const out: Side = { contracts: [], scopes: new Set(), wildcard: false }
	if (!Array.isArray(list)) return out
	for (const cap of list) {
		const type = fieldOf(cap, "type")
		if (type === "contracts") readContracts(fieldOf(cap, "contracts"), out)
		else if (type === "transaction") readScope(fieldOf(cap, "scope"), "transaction", out)
		else if (type === "simulation") {
			readScope(fieldOf(fieldOf(cap, "transactions"), "scope"), "simulation.transactions", out)
			readScope(fieldOf(fieldOf(cap, "utilities"), "scope"), "simulation.utilities", out)
		}
	}
	return out
}

function grantedAccountsEntries(answer: unknown): unknown[] {
	const granted = fieldOf(answer, "granted")
	if (!Array.isArray(granted)) return []
	const cap = granted.find((c) => fieldOf(c, "type") === "accounts")
	const accounts = fieldOf(cap, "accounts")
	return Array.isArray(accounts) ? accounts : []
}

/**
 * The account addresses a wallet's answer grants: each entry must parse as an Aztec address (syntax
 * only; the wallet enforces authorization per call), malformed or throwing entries are skipped,
 * duplicates collapse, and the list stops at `MAX_GRANTED_ACCOUNTS`.
 */
export function grantedAccounts(answer: unknown): AztecAddress[] {
	const out: AztecAddress[] = []
	for (const entry of grantedAccountsEntries(answer)) {
		const address = parseAztecAddress(fieldOf(entry, "item"))
		if (address !== null && !out.includes(address)) out.push(address)
		if (out.length === MAX_GRANTED_ACCOUNTS) break
	}
	return out
}

/**
 * The request intersected with the answer. A requested contract is kept only when the answer lists it
 * and returns every scope the request named on it; a scope on a contract the request does not register
 * (the fee contract) is kept on its own. Anything the request did not name is ignored, and a `"*"` on
 * either side grants no contract and no scope.
 */
export function parseGrant(request: unknown, answer: unknown): Grant {
	const accounts = grantedAccounts(answer)
	const asked = readSide(fieldOf(request, "capabilities"))
	const given = readSide(fieldOf(answer, "granted"))
	if (asked.wildcard || given.wildcard) return { accounts, contracts: [], scopes: new Set() }
	const askedOn = (c: AztecAddress) => [...asked.scopes].filter((k) => contractOfKey(k) === c)
	const contracts = asked.contracts.filter((c) => given.contracts.includes(c) && askedOn(c).every((k) => given.scopes.has(k)))
	const scopes = new Set(
		[...asked.scopes].filter((k) => {
			const c = contractOfKey(k) as AztecAddress
			return given.scopes.has(k) && (contracts.includes(c) || !asked.contracts.includes(c))
		}),
	)
	return { accounts, contracts, scopes }
}
