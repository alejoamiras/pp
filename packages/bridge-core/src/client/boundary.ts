import { OutboxAbi } from "@aztec-foundation/l1-artifacts/OutboxAbi"
import { SpecRangeError } from "@pp/bridge-spec"
import { PoolClientError } from "@pp/pool-client"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "../factory-abi"
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

/** The error names a decoded revert may carry out: those of the contracts the client calls through viem. */
const REVERT_NAMES: ReadonlySet<string> = new Set(
	[...PROCESSOR_PORTAL_ABI, ...PORTAL_FACTORY_ABI, ...OutboxAbi].flatMap((i) => (i.type === "error" ? [i.name] : [])),
)

/**
 * A contract revert anywhere in an error chain, as opposed to a transport failure: viem's
 * `ContractFunctionRevertedError`, found by name in one walk. `revert` is its decoded error name
 * when that names an error of a contract the client calls.
 */
export function contractRevert(e: unknown): { revert?: string } | null {
	const found = causeChain(e).find((x) => field(x, "name") === "ContractFunctionRevertedError")
	if (!found) return null
	const data = field(found, "data")
	const name = typeof data === "object" && data !== null ? field(data, "errorName") : undefined
	return typeof name === "string" && REVERT_NAMES.has(name) ? { revert: name } : {}
}

/** viem's wrappers around a send's error: they add context and say nothing about whether it was broadcast. */
const SEND_WRAPPERS: ReadonlySet<unknown> = new Set(["ContractFunctionExecutionError", "TransactionExecutionError"])

/** Whether a link of `e`'s chain matches `found` with only viem's send wrappers above it. */
function underSendWrappers(e: unknown, found: (x: object) => boolean): boolean {
	for (const x of causeChain(e)) {
		if (found(x)) return true
		if (!SEND_WRAPPERS.has(field(x, "name"))) return false
	}
	return false
}

/**
 * Whether the user refused the request: an EIP-1193 4001 with only viem's send wrappers above it.
 * Anything else above a 4001, such as a timeout, may follow a broadcast, so it is not a refusal.
 */
export const isUserRejection = (e: unknown): boolean => underSendWrappers(e, (x) => field(x, "code") === 4001)

/**
 * Whether viem refused to send because the wallet is on another chain: its `ChainMismatchError`
 * with only the send wrappers above it. viem 2.57.1 raises it in `sendTransaction`
 * (`assertCurrentChain`, actions/wallet/sendTransaction.ts:223-229) before it requests
 * `eth_sendTransaction` (:264), so nothing was sent. A wallet's own error reaches here under viem's RPC error classes,
 * which are no wrappers.
 */
export const isChainMismatch = (e: unknown): boolean => underSendWrappers(e, (x) => field(x, "name") === "ChainMismatchError")

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
	const reverted = contractRevert(e)
	if (reverted) return new BridgeClientError("SIMULATION_REVERTED", reverted)
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
