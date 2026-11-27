import { type Hex, isAddressEqual, type TypedDataDefinition } from "viem"
import { BridgeFailure, type UiCode } from "./errors"
import type { L1Port, Session, SessionPort } from "./ports"

const NAMES: Record<number, string> = { 1: "Ethereum", 11155111: "Sepolia", 31337: "the local chain (31337)" }

export const chainName = (id: number): string => NAMES[id] ?? `chain ${id}`

type OpenRefusal = Extract<UiCode, "CHAIN_MISMATCH" | "NO_SENDER" | "CONTEXT_CHANGED">

/**
 * Opens the owner's session from the selected Ethereum account. The chain is checked first, so a
 * wallet on the wrong network is asked to switch and never to sign the secret-derivation payload; the
 * session may read other things before it asks, so the account and chain are checked again right
 * before the wallet is.
 */
export async function openOwnerSession(a: {
	l1: L1Port
	sessions: SessionPort
	chainId: number
}): Promise<{ ok: true; session: Session } | { ok: false; code: OpenRefusal }> {
	const [owner] = await a.l1.accounts()
	if (!owner) return { ok: false, code: "NO_SENDER" }
	if ((await a.l1.chainId()) !== a.chainId) return { ok: false, code: "CHAIN_MISMATCH" }
	const moved: { code: Exclude<OpenRefusal, "NO_SENDER"> | null } = { code: null }
	const sign = async (td: TypedDataDefinition): Promise<Hex> => {
		const [[account], chainId] = await Promise.all([a.l1.accounts(), a.l1.chainId()])
		if (chainId !== a.chainId) moved.code = "CHAIN_MISMATCH"
		else if (account === undefined || !isAddressEqual(account, owner)) moved.code = "CONTEXT_CHANGED"
		if (moved.code !== null) throw new BridgeFailure(moved.code)
		return a.l1.signTypedData(owner, td)
	}
	try {
		return { ok: true, session: await a.sessions.open({ owner, sign }) }
	} catch (err) {
		if (moved.code !== null) return { ok: false, code: moved.code }
		throw err
	}
}
