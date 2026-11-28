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
		case "KEYSTORE_MISMATCH":
			return new BridgeClientError("DEPLOYMENT_MISMATCH")
		case "REGISTERED_TO_OTHER_KEYS":
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

/**
 * The innermost error in `e`'s chain that names its kind, as `source`: under viem's send wrappers that
 * is the class the send failed with (`InsufficientFundsError`, `ChainMismatchError`). Only the name.
 */
export function innermostSource(e: unknown): { source?: string } {
	for (const x of causeChain(e).reverse()) {
		const name = kindOf(x)
		if (name !== undefined) return { source: name }
	}
	return {}
}

/** Hex digits alone, the way every key, salt, signature and opening here is written; no error's name. */
const HEX_RUN = /^[0-9a-f]{16,}$/i

/**
 * The kind `x` names: its `name` field, else its class's name; `Error` names none. The field comes
 * first because a minifier renames classes but never the `name` an error sets. A `name` can carry
 * data, so a hex run is refused rather than taken for a kind.
 */
function kindOf(x: object): string | undefined {
	const named = (v: unknown) => {
		const name = identifier(v)
		return name === "Error" || (name !== undefined && HEX_RUN.test(name)) ? undefined : name
	}
	const ctor = field(x, "constructor")
	// A subclass that never sets `name` keeps `Error` there; its class still names it.
	return named(field(x, "name")) ?? (typeof ctor === "function" ? named(field(ctor, "name")) : undefined)
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

/**
 * Whether the user refused the request: an EIP-1193 4001 with only viem's send wrappers above it.
 * Anything else above a 4001, such as a timeout, may follow a broadcast, so it is not a refusal.
 */
export function isUserRejection(e: unknown): boolean {
	for (const x of causeChain(e)) {
		if (field(x, "code") === 4001) return true
		if (!SEND_WRAPPERS.has(field(x, "name"))) return false
	}
	return false
}

/**
 * The error a wallet send the user refused ends in: `RPC_FAILED` with source
 * `UserRejectedRequestError`; `null` for any other failure, which may follow a broadcast.
 *
 * Contract: a refusal as `isUserRejection` reads it is taken as proof the wallet sent nothing, so a
 * caller treats the send as never made. A wallet that broadcasts and then answers 4001 breaks it; a
 * later send of the same note or ticket then reverts, at the cost of its gas.
 */
export function walletRefusal(e: unknown): BridgeClientError | null {
	return isUserRejection(e) ? new BridgeClientError("RPC_FAILED", { source: "UserRejectedRequestError" }) : null
}

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
	const name = e instanceof Error ? kindOf(e) : undefined
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
