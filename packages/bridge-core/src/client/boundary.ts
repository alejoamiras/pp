import { SpecRangeError } from "@pp/bridge-spec"
import { PoolClientError } from "@pp/pool-client"
import { BridgeClientError, isSpendCheckName, rebuildError } from "./errors"

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const identifier = (v: unknown): string | undefined => (typeof v === "string" && IDENTIFIER.test(v) ? v : undefined)

function fromPool(e: PoolClientError): BridgeClientError {
	const code = e.code
	switch (code) {
		case "STATE_ROOT_STALE":
		case "KEYSTORE_ROOT_STALE":
		case "ASP_ROOT_STALE":
			return new BridgeClientError("STALE", { stale: code })
		case "SPEND_CHECK_FAILED":
			return new BridgeClientError("SPEND_MISMATCH", isSpendCheckName(e.check) ? { check: e.check } : { source: code })
		case "NOTE_NOT_FOUND":
		case "NULLIFIER_NOT_FOUND":
			return new BridgeClientError("NOTE_NOT_FOUND")
		case "CHAIN_MISMATCH":
			return new BridgeClientError("CHAIN_MISMATCH")
		case "SIGNATURE_INVALID":
		case "ARTIFACT_MISMATCH":
		case "ASSET_MISMATCH":
		case "NOTE_NOT_APPROVED":
		case "AMOUNT_OUT_OF_RANGE":
			return new BridgeClientError("SPEND_MISMATCH", { source: code })
		default: {
			const unhandled: never = code
			return new BridgeClientError("RPC_FAILED", { source: identifier(unhandled) ?? "PoolClientError" })
		}
	}
}

/**
 * `e` and the errors in its cause chain, outermost first, for matching by shape: a caller's wallet
 * client or pool-client can bring its own copy of viem, whose error classes `instanceof` misses.
 * Stops at a cycle, at a throwing `cause`, and after 32 links.
 */
function causeChain(e: unknown): object[] {
	const chain: object[] = []
	for (let x = e; typeof x === "object" && x !== null && !chain.includes(x) && chain.length < 32; ) {
		chain.push(x)
		try {
			x = (x as { cause?: unknown }).cause
		} catch {
			break
		}
	}
	return chain
}

const field = (x: object, key: string): unknown => {
	try {
		return (x as Record<string, unknown>)[key]
	} catch {
		return undefined
	}
}

/** viem's revert error anywhere in an error chain, by name: a contract refused the call, as opposed to a transport failure. */
export const contractRevert = (e: unknown): { data?: { errorName?: unknown } } | null =>
	causeChain(e).find((x) => field(x, "name") === "ContractFunctionRevertedError") ?? null

/** The decoded error name of a contract revert anywhere in a viem error chain, when it is an identifier. */
export const revertName = (e: unknown): string | undefined => {
	const revert = contractRevert(e)
	const data = revert ? field(revert, "data") : undefined
	return typeof data === "object" && data !== null ? identifier(field(data, "errorName")) : undefined
}

/** Whether the user refused the request: an EIP-1193 4001 anywhere in the error chain. */
export const isUserRejection = (e: unknown): boolean => causeChain(e).some((x) => field(x, "code") === 4001)

/**
 * Maps any thrown value to a `BridgeClientError` built from allow-listed identifiers only. It never
 * keeps a cause, a lower message, arguments, calldata or a serialized transaction, so whatever the
 * lower layers put in their messages (amounts, openings, signatures) stops here.
 */
export function translate(e: unknown): BridgeClientError {
	try {
		return translateOrThrow(e)
	} catch {
		// A detail the error type refuses (say, a check name pool-client added later) still maps.
		return new BridgeClientError("RPC_FAILED", { source: "TranslationFailed" })
	}
}

function translateOrThrow(e: unknown): BridgeClientError {
	// Rebuilt, never passed through: a caller's callback can throw one carrying a cause or extra fields.
	if (e instanceof BridgeClientError) return rebuildError(e)
	if (e instanceof PoolClientError) return fromPool(e)
	if (e instanceof SpecRangeError) return new BridgeClientError("SPEND_MISMATCH", { source: identifier(e.code) ?? "SpecRangeError" })
	if (contractRevert(e)) {
		const revert = revertName(e)
		return new BridgeClientError("SIMULATION_REVERTED", revert ? { revert } : {})
	}
	const name = e instanceof Error ? (identifier(e.constructor?.name) ?? identifier(e.name)) : undefined
	return new BridgeClientError("RPC_FAILED", name ? { source: name } : {})
}

/** Runs `f`, translating whatever it throws. Every exported client function goes through this. */
export async function guarded<T>(f: () => Promise<T>): Promise<T> {
	try {
		return await f()
	} catch (e) {
		throw translate(e)
	}
}
