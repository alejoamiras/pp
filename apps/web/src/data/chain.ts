import { type Address, type Hex, isAddressEqual, type TypedDataDefinition } from "viem"
import { BridgeFailure, type UiCode } from "./errors"
import type { L1Port, Session, SessionPort } from "./ports"

const NAMES: Record<number, string> = { 1: "Ethereum", 11155111: "Sepolia", 31337: "the local chain (31337)" }

export const chainName = (id: number): string => NAMES[id] ?? `chain ${id}`

type OpenRefusal = Extract<UiCode, "CHAIN_MISMATCH" | "NO_SENDER" | "CONTEXT_CHANGED">

type Moved = Exclude<OpenRefusal, "NO_SENDER"> | null

function moved(owner: Address, account: Address | null | undefined, chainId: number | null, expected: number): Moved {
	if (chainId !== expected) return "CHAIN_MISMATCH"
	return account == null || !isAddressEqual(account, owner) ? "CONTEXT_CHANGED" : null
}

/**
 * Opens the owner's session from the selected Ethereum account. The chain is checked first, so a
 * wallet on the wrong network is asked to switch and never to sign the secret-derivation payload. The
 * session may read other things before it asks, so the wallet is read again then; and since a switch
 * can land between those two reads, `selected` (the wallet's events, read synchronously) and `current`
 * are checked with nothing awaited between them and the signature request.
 */
export async function openOwnerSession(a: {
	l1: L1Port
	sessions: SessionPort
	chainId: number
	/** The selected account and chain as the wallet's events last reported them. */
	selected(): { account: Address | null; chainId: number | null }
	/** Whether this sign-in is still the page's latest; a replaced one never reaches the wallet. */
	current(): boolean
}): Promise<{ ok: true; session: Session } | { ok: false; code: OpenRefusal }> {
	const [owner] = await a.l1.accounts()
	if (!owner) return { ok: false, code: "NO_SENDER" }
	if ((await a.l1.chainId()) !== a.chainId) return { ok: false, code: "CHAIN_MISMATCH" }
	const refused: { code: Moved } = { code: null }
	const sign = async (td: TypedDataDefinition): Promise<Hex> => {
		const [[account], chainId] = await Promise.all([a.l1.accounts(), a.l1.chainId()])
		const now = a.selected()
		refused.code = moved(owner, account, chainId, a.chainId) ?? moved(owner, now.account, now.chainId, a.chainId)
		if (refused.code === null && !a.current()) refused.code = "CONTEXT_CHANGED"
		if (refused.code !== null) throw new BridgeFailure(refused.code)
		return a.l1.signTypedData(owner, td)
	}
	try {
		return { ok: true, session: await a.sessions.open({ owner, sign }) }
	} catch (err) {
		if (refused.code !== null) return { ok: false, code: refused.code }
		throw err
	}
}
