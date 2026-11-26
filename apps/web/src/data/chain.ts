import type { UiCode } from "./errors"
import type { L1Port, Session, SessionPort } from "./ports"

const NAMES: Record<number, string> = { 1: "Ethereum", 11155111: "Sepolia", 31337: "the local chain (31337)" }

export const chainName = (id: number): string => NAMES[id] ?? `chain ${id}`

/**
 * Opens the owner's session from the selected Ethereum account. The chain is checked first, so a
 * wallet on the wrong network is asked to switch and never to sign the secret-derivation payload.
 */
export async function openOwnerSession(a: {
	l1: L1Port
	sessions: SessionPort
	chainId: number
}): Promise<{ ok: true; session: Session } | { ok: false; code: Extract<UiCode, "CHAIN_MISMATCH" | "NO_SENDER"> }> {
	const [owner] = await a.l1.accounts()
	if (!owner) return { ok: false, code: "NO_SENDER" }
	if ((await a.l1.chainId()) !== a.chainId) return { ok: false, code: "CHAIN_MISMATCH" }
	const session = await a.sessions.open({ owner, sign: (td) => a.l1.signTypedData(owner, td) })
	return { ok: true, session }
}
