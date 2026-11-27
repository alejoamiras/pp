import { describe, expect, test } from "vitest"
import { isWalletRefusal, ProviderError, REFUSAL_SHAPES } from "./errors"

/** The released wallet's Reject, as wallet-sdk 6.0.0's extension transport throws it; the trace id varies. */
const envelope = (walletErrorCode: string, code = 4001) =>
	new Error(JSON.stringify({ code, message: "User rejected", data: { walletErrorCode, walletTraceId: "71faf217" } }))

const named = (name: string) => Object.assign(new Error("no"), { name })

describe("the refusals trusted past the handoff", () => {
	test.each([
		["EIP-1193 provider (4001)", new ProviderError(4001, "User rejected the request.")],
		["viem", named("UserRejectedRequestError")],
		["wallet-sdk 6.0.0 extension (released wallet)", envelope("USER_REJECTED")],
	])("%s: its refusal is a no", (wallet, err) => {
		expect(REFUSAL_SHAPES.find((s) => s.wallet === wallet)?.matches(err as never)).toBe(true)
		expect(isWalletRefusal(err)).toBe(true)
	})

	test.each([
		["refusal wording inside another failure", new Error("could not determine whether the user canceled")],
		["the wording alone", new Error("User rejected the request")],
		["the envelope of a cancelled job", envelope("JOB_CANCELLED")],
		["the envelope's wallet code under another code", envelope("USER_REJECTED", -32603)],
		["the envelope inside a longer message", new Error(`relay failed: ${envelope("USER_REJECTED").message}`)],
		["the kit wallet's injected failure, JSON-quoted", new Error(JSON.stringify("test wallet: injected failure of sendTx"))],
		["a 4001 only in the cause", new Error("send failed", { cause: new ProviderError(4001, "no") })],
		["nothing thrown as an object", "User rejected"],
	])("%s may hide a broadcast", (_, err) => {
		expect(isWalletRefusal(err)).toBe(false)
	})
})
