/**
 * The owner's keystore registration, one call at a time. The session names the next call from chain
 * state; the owner's wallet sends it behind a handoff bound to the context the user confirmed in; the
 * next step is read no earlier than that call's receipt block. Nothing is resent on its own: a step the
 * chain still needs once its call mined stops the run.
 */
import { type Hash, isAddressEqual } from "viem"
import { codeOf, isWalletRefusal, type UiCode } from "./errors"
import type { Session } from "./ports"
import { bindL1Send, type SendContext } from "./sends"
import type { RegistrationCall, RegistrationStep } from "./stack-types"

export type RegisterResult = { ok: true } | { ok: false; code: UiCode; txHash?: Hash }

export interface RegisterDeps {
	session: Pick<Session, "owner" | "registrationStep" | "sendRegistration" | "registrationReceipt">
	live: () => SendContext
	chainId: number
}

type Mined = { fn: RegistrationCall["function"]; hash: Hash; reverted: boolean; block: bigint }

/** Each call sets one of the owner's two keys, so a third means the chain is not moving. */
const MAX_CALLS = 2

/** A failed send: the guard's refusal and the wallet's no sent nothing; past the handoff, it may have. */
function sendFailure(err: unknown, refused: boolean, handedOff: boolean): UiCode {
	if (refused) return "CONTEXT_CHANGED"
	if (isWalletRefusal(err)) return "WALLET_REJECTED"
	if (!handedOff)
		return (err as { name?: unknown } | null)?.name === "ChainMismatchError" ? "CHAIN_MISMATCH" : (codeOf(err) ?? "RPC_FAILED")
	return codeOf(err) ?? "UNCERTAIN"
}

async function sendOne(
	d: RegisterDeps,
	call: RegistrationCall,
	handoff: () => void,
	refused: () => boolean,
): Promise<Mined | RegisterResult> {
	let handedOff = false
	let hash: Hash
	try {
		hash = await d.session.sendRegistration(call, () => {
			handoff()
			handedOff = true
		})
	} catch (err) {
		return { ok: false, code: sendFailure(err, refused(), handedOff) }
	}
	const receipt = await d.session.registrationReceipt(hash).catch(() => null)
	if (receipt === null) return { ok: false, code: "TX_UNCONFIRMED", txHash: hash }
	return { fn: call.function, hash, reverted: receipt.status !== "success", block: receipt.blockNumber }
}

/**
 * Registers the session owner from the selected account, which must be the owner on the deployment's
 * chain. A reverted call is followed by a fresh step, since another tab may have sent the same call
 * first; the run stops when the chain still asks for the call that just mined.
 */
export async function registerOwner(d: RegisterDeps): Promise<RegisterResult> {
	const now = d.live()
	if (now.account === null || !isAddressEqual(now.account, d.session.owner)) return { ok: false, code: "REGISTER_FROM_OWNER" }
	if (now.chainId !== d.chainId) return { ok: false, code: "CHAIN_MISMATCH" }
	const bound = bindL1Send(d.live, d.session.owner, d.chainId, now.demo ?? false)
	let last: Mined | undefined
	for (let calls = 0; ; calls++) {
		const step = await readStep(d, last?.block)
		if ("ok" in step) return step
		if (step.status === "registered") return { ok: true }
		const stop = stopBefore(step.call, last, calls)
		if (stop) return stop
		const mined = await sendOne(d, step.call, bound.handoff, bound.refused)
		if ("ok" in mined) return mined
		last = mined
	}
}

async function readStep(d: RegisterDeps, after: bigint | undefined): Promise<RegistrationStep | RegisterResult> {
	try {
		return await d.session.registrationStep(after)
	} catch (err) {
		return { ok: false, code: codeOf(err) ?? "RPC_FAILED" }
	}
}

/** The chain asking again for the call that just mined, or for a third call, stops the run. */
function stopBefore(next: RegistrationCall, last: Mined | undefined, calls: number): RegisterResult | null {
	if (last?.fn !== next.function && calls < MAX_CALLS) return null
	return { ok: false, code: last?.reverted ? "REVERTED" : "RPC_INCONSISTENT", ...(last ? { txHash: last.hash } : {}) }
}
