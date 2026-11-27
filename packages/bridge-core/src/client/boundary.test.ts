import { inspect } from "node:util"
import { SpecRangeError } from "@pp/bridge-spec"
import { PoolClientError, type PoolClientErrorCode } from "@pp/pool-client"
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, type Hex, toHex, UserRejectedRequestError } from "viem"
import { describe, expect, it, vi } from "vitest"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { CLAIM_KEY, foreignError, SIGNATURE } from "../test/client-fakes"
import { guarded, isUserRejection, translate } from "./boundary"
import { BridgeClientError } from "./errors"

const MAPPED: Record<PoolClientErrorCode, object> = {
	SIGNATURE_INVALID: { code: "SPEND_MISMATCH", source: "SIGNATURE_INVALID" },
	CHAIN_MISMATCH: { code: "CHAIN_MISMATCH" },
	STATE_ROOT_STALE: { code: "STALE", stale: "STATE_ROOT_STALE" },
	KEYSTORE_ROOT_STALE: { code: "STALE", stale: "KEYSTORE_ROOT_STALE" },
	ASP_ROOT_STALE: { code: "STALE", stale: "ASP_ROOT_STALE" },
	NOTE_NOT_FOUND: { code: "NOTE_NOT_FOUND" },
	NOTE_NOT_APPROVED: { code: "SPEND_MISMATCH", source: "NOTE_NOT_APPROVED" },
	AMOUNT_OUT_OF_RANGE: { code: "SPEND_MISMATCH", source: "AMOUNT_OUT_OF_RANGE" },
	ASSET_MISMATCH: { code: "SPEND_MISMATCH", source: "ASSET_MISMATCH" },
	ARTIFACT_MISMATCH: { code: "SPEND_MISMATCH", source: "ARTIFACT_MISMATCH" },
	SPEND_CHECK_FAILED: { code: "SPEND_MISMATCH", check: "context" },
	NULLIFIER_NOT_FOUND: { code: "NOTE_NOT_FOUND" },
}

// Values that must never surface: the signature, the claim key, a salt and an opening, in hex and decimal.
const SALT = 0x5a17_5a17_5a17_5a17_5a17n
const OPENING = 0x0be7_0be7_0be7_0be7_0be7n
const KEY_HEX = toHex(CLAIM_KEY)
const SENTINELS = [SIGNATURE, KEY_HEX, toHex(SALT), SALT.toString(), toHex(OPENING), OPENING.toString()].flatMap((s) => [
	s,
	s.replace(/^0x/, ""),
])

function expectClean(views: readonly string[]): void {
	for (const view of views) for (const s of SENTINELS) expect(view.toLowerCase()).not.toContain(s.toLowerCase())
}

const leaky = (): unknown[] => [
	new PoolClientError("SPEND_CHECK_FAILED", `opening ${OPENING} salt ${SALT}`, { check: "change" }),
	new PoolClientError("SIGNATURE_INVALID", `bad ${SIGNATURE}`),
	new SpecRangeError("SecretHashOutOfRange", "secretHash", toHex(SALT)),
	new ContractFunctionExecutionError(new BaseError(`reverted with ${KEY_HEX}`), {
		abi: PROCESSOR_PORTAL_ABI,
		functionName: "bridgeFromPool",
		args: [SALT, OPENING],
	}),
	new ContractFunctionRevertedError({
		abi: PROCESSOR_PORTAL_ABI,
		functionName: "bridgeFromPool",
		data: `0xdeadbeef${SALT.toString(16)}` as Hex,
	}),
	new UserRejectedRequestError(new Error(`user rejected signing ${SIGNATURE}`)),
	new TypeError(`cannot read ${OPENING}`),
	Object.assign(new Error(`rpc ${KEY_HEX}`), { name: `${SIGNATURE}` }),
	`thrown string ${SALT}`,
	// A caller's callback can throw the client's own error type, decorated.
	Object.assign(new BridgeClientError("UNCERTAIN"), { cause: new Error(`salt ${SALT}`), opening: OPENING, message: `${KEY_HEX}` }),
	new BridgeClientError("RPC_FAILED", { source: "x", extra: SIGNATURE } as never),
]

describe("error boundary", () => {
	it.each(Object.entries(MAPPED))("maps pool-client's %s", (code, expected) => {
		const e = new PoolClientError(code as PoolClientErrorCode, "x", code === "SPEND_CHECK_FAILED" ? { check: "context" } : {})
		expect(translate(e)).toMatchObject(expected)
	})

	it("keeps no sentinel in any translated error, its JSON, its inspection, or the console", async () => {
		const out: string[] = []
		const capture = (...a: unknown[]) => void out.push(a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: 10 }))).join(" "))
		const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture))
		const translated = await Promise.all(leaky().map((thrown) => guarded(() => Promise.reject(thrown)).catch((x: unknown) => x)))
		for (const e of translated) console.error(e)
		for (const s of spies) s.mockRestore()
		for (const e of translated) {
			expectClean([String(e), JSON.stringify(e), inspect(e, { depth: 10, showHidden: true }), (e as Error).stack ?? ""])
			expect(e).not.toHaveProperty("cause")
		}
		expectClean(out)
	})

	it("reads a revert by shape from an error another copy of viem built, names only the client's contract errors, and ends on a cyclic chain", () => {
		const reverted = (errorName: string) =>
			foreignError(["ContractFunctionExecutionError"], ["ContractFunctionRevertedError", { data: { errorName } }])
		expect(reverted("CapExceeded")).not.toBeInstanceOf(BaseError)
		expect(translate(reverted("CapExceeded"))).toMatchObject({ code: "SIMULATION_REVERTED", revert: "CapExceeded" })
		const forged = translate(reverted("PrivateOpening_12345"))
		expect([forged.code, forged.revert]).toEqual(["SIMULATION_REVERTED", undefined])
		const cyclic = foreignError(["TransactionExecutionError"])
		Object.assign(cyclic, { cause: cyclic })
		expect([isUserRejection(cyclic), translate(cyclic).code]).toEqual([false, "RPC_FAILED"])
	})

	it("refuses detail values outside each field's allowed set, and translate still never throws", () => {
		expect(() => new BridgeClientError("REVERTED", { l1TxHash: "0x12" as Hex })).toThrow(TypeError)
		expect(() => new BridgeClientError("SPEND_MISMATCH", { check: "opening" as never })).toThrow(TypeError)
		expect(() => new BridgeClientError("NOPE" as never)).toThrow(TypeError)
		const forged = Object.assign(new BridgeClientError("UNCERTAIN"), { code: "NOPE", l1TxHash: `${SALT}` })
		expect(translate(forged)).toMatchObject({ code: "RPC_FAILED", source: "BridgeClientError" })
		const unknownCheck = new PoolClientError("SPEND_CHECK_FAILED", "x", { check: "brandNew" as never })
		expect(translate(unknownCheck)).toMatchObject({ code: "SPEND_MISMATCH", source: "SPEND_CHECK_FAILED" })
	})
})
