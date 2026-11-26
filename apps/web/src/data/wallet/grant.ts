import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AppCapabilities } from "@aztec-labs/aztec.js/wallet"

/** Bound on the granted list: wallet-controlled input. */
export const MAX_GRANTED_ACCOUNTS = 16

/** The connect-time request: the accounts and nothing else; no auth witnesses, no contract scope. */
export function connectManifest(): AppCapabilities {
	return {
		version: "1.0",
		metadata: { name: "pp", version: "0.1.0" },
		capabilities: [{ type: "accounts", canGet: true, canCreateAuthWit: false }],
	}
}

function canonicalAddress(item: unknown): string | null {
	try {
		const raw = typeof item === "string" ? item : String((item as { toString(): string }).toString())
		return AztecAddress.fromStringUnsafe(raw).toString()
	} catch {
		return null
	}
}

function grantedAccountsEntries(grant: unknown): unknown[] {
	const granted = (grant as { granted?: unknown } | null)?.granted
	if (!Array.isArray(granted)) return []
	const cap = granted.find((c) => (c as { type?: unknown } | null)?.type === "accounts") as { accounts?: unknown } | undefined
	return Array.isArray(cap?.accounts) ? cap.accounts : []
}

/**
 * The account addresses a wallet's answer grants, read as untrusted input: each entry must round-trip
 * `AztecAddress` (syntax only; the wallet enforces authorization per call), malformed or throwing
 * entries are skipped, duplicates collapse, and the list stops at `MAX_GRANTED_ACCOUNTS`.
 */
export function grantedAccounts(grant: unknown): string[] {
	const out: string[] = []
	for (const entry of grantedAccountsEntries(grant)) {
		const address = canonicalAddress((entry as { item?: unknown } | null)?.item)
		if (address !== null && !out.includes(address)) out.push(address)
		if (out.length === MAX_GRANTED_ACCOUNTS) break
	}
	return out
}
