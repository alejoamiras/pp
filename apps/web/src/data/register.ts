/**
 * The owner's keystore registration, one call at a time. The session names the next call from chain
 * state; the owner's wallet sends it behind a handoff bound to the context the user confirmed in and
 * to the open session; the next step is read no earlier than that call's receipt block. Nothing is
 * resent on its own: a step the chain still needs once its call mined stops the run.
 */
import { type Address, type Hash, isAddressEqual } from "viem"
import { codeOf, isWalletRefusal, type UiCode } from "./errors"
import type { Session } from "./ports"
import { bindL1Send, type SendContext } from "./sends"
import type { RegistrationCall, RegistrationStep } from "./stack-types"

/** `done`: a call of this run that mined and set its key before the run stopped. */
export type RegisterResult = { ok: true } | { ok: false; code: UiCode; txHash?: Hash; done?: Hash }

export interface RegisterDeps {
	session: Pick<Session, "owner" | "registrationStep" | "sendRegistration" | "registrationReceipt">
	/** `owner` is the signed-in owner, `null` once its session closes. */
	live: () => SendContext & { readonly owner: Address | null }
	chainId: number
}

type Mined = { fn: RegistrationCall["function"]; hash: Hash; reverted: boolean; replaced: boolean; block: bigint }

type Failed = Extract<RegisterResult, { ok: false }>

/** Each call sets one of the owner's two keys, so a third means the chain is not moving. */
const MAX_CALLS = 2

/** A failed send: the guard's refusal and the wallet's no sent nothing; anything else past the handoff may have. */
function sendFailure(err: unknown, refused: boolean, handedOff: boolean): UiCode {
	if (refused) return "CONTEXT_CHANGED"
	if (isWalletRefusal(err)) return "WALLET_REJECTED"
	if (handedOff) return "UNCERTAIN"
	return codeOf(err) ?? "RPC_FAILED"
}

interface Bound {
	handoff(): void
	refused(): boolean
}

/** The confirmed context's handoff, refusing too once the owner's session closed. */
function bindRegistration(d: RegisterDeps, demo: boolean): Bound {
	const owner = d.session.owner
	const bound = bindL1Send(d.live, owner, d.chainId, demo)
	let closed = false
	return {
		handoff() {
			const now = d.live().owner
			if (now === null || !isAddressEqual(now, owner)) {
				closed = true
				throw new Error("the owner's session closed")
			}
			bound.handoff()
		},
		refused: () => closed || bound.refused(),
	}
}

async function sendOne(d: RegisterDeps, call: RegistrationCall, bound: Bound): Promise<Mined | Failed> {
	let handedOff = false
	let hash: Hash
	try {
		hash = await d.session.sendRegistration(call, () => {
			bound.handoff()
			handedOff = true
		})
	} catch (err) {
		return { ok: false, code: sendFailure(err, bound.refused(), handedOff) }
	}
	const receipt = await d.session.registrationReceipt(hash).catch(() => null)
	if (receipt === null) return { ok: false, code: "TX_UNCONFIRMED", txHash: hash }
	const replaced = receipt.hash.toLowerCase() !== hash.toLowerCase()
	return { fn: call.function, hash: receipt.hash, reverted: receipt.status !== "success", replaced, block: receipt.blockNumber }
}

/**
 * Registers the session owner from the selected account, which must be the owner on the deployment's
 * chain. A reverted or replaced call is followed by a fresh step, since another tab may have sent the
 * same call first; the run stops when the chain still asks for the call that just mined.
 */
export async function registerOwner(d: RegisterDeps): Promise<RegisterResult> {
	const now = d.live()
	const refused = precheck(d, now)
	if (refused) return refused
	const bound = bindRegistration(d, now.demo ?? false)
	const run = progress()
	let last: Mined | undefined
	for (let calls = 0; ; calls++) {
		const step = await readStep(d, last?.block)
		if ("ok" in step) return run.failed(step)
		if (step.status === "registered") return { ok: true }
		const stop = stopBefore(step.call, last, calls)
		if (stop) return run.failed(stop)
		run.movedPast(last)
		const mined = await sendOne(d, step.call, bound)
		if ("ok" in mined) return run.failed(mined)
		run.mined(mined)
		last = mined
	}
}

/**
 * The run's first call that mined while its key got set: at its own successful receipt, or, for a
 * replacement, once the chain moved past its step (the key is then set, if not necessarily by it).
 */
function progress() {
	let done: Hash | undefined
	return {
		mined(m: Mined) {
			if (!m.reverted && !m.replaced) done ??= m.hash
		},
		// What a replacement under another hash did shows only once the next step has moved on.
		movedPast(last: Mined | undefined) {
			if (last && !last.reverted) done ??= last.hash
		},
		failed: (f: Failed): Failed => (done && done !== f.txHash ? { ...f, done } : f),
	}
}

function precheck(d: RegisterDeps, now: SendContext): Failed | null {
	if (now.account === null || !isAddressEqual(now.account, d.session.owner)) return { ok: false, code: "REGISTER_FROM_OWNER" }
	if (now.chainId !== d.chainId) return { ok: false, code: "CHAIN_MISMATCH" }
	return null
}

async function readStep(d: RegisterDeps, after: bigint | undefined): Promise<RegistrationStep | Failed> {
	try {
		return await d.session.registrationStep(after)
	} catch (err) {
		return { ok: false, code: codeOf(err) ?? "RPC_FAILED" }
	}
}

/** The chain asking again for the call that just mined, or for a third call, stops the run. */
function stopBefore(next: RegistrationCall, last: Mined | undefined, calls: number): Failed | null {
	if (last?.fn !== next.function && calls < MAX_CALLS) return null
	const again = last?.fn === next.function
	const code: UiCode = again && last.replaced ? "REGISTRATION_REPLACED" : again && last.reverted ? "REVERTED" : "RPC_INCONSISTENT"
	return { ok: false, code, ...(last ? { txHash: last.hash } : {}) }
}
