import { readFileSync, statSync } from "node:fs"
import { BridgeClientError } from "@pp/bridge-core"
import { describe, expect, it } from "vitest"
import { GuardError } from "./errors"
import { remember } from "./redact"
import { CanaryError, CanaryReport, outcomeOf, reportText } from "./report"
import { scratchHome } from "./test-support"

describe("the canary's report", () => {
	it("keeps only allowlisted fields, entry fields and timing names, and scrubs every loaded value", () => {
		const secret = `0x${"5e".repeat(32)}`
		remember([secret])
		const text = reportText({
			version: 1,
			exitClass: "FAILED",
			errorClass: `leaked ${secret}`,
			oneTx: true,
			claimSalt: "0x01",
			signature: "0x02",
			steps: { bridge: 12, unknownStep: 3 },
			waits: { epochProof: 1500, approval: "soon" },
			burns: [{ txHash: "0xab", amount: 5n, secret }],
			checks: [{ step: "selfTransfer", marginSec: 412n, salt: 9n, failed: ["margin"] }],
			unsettled: ["0xab"],
			sends: [{ step: "burn", txHash: "0xab", receipt: { raw: true } }],
		})
		expect(JSON.parse(text)).toEqual({
			version: 1,
			exitClass: "FAILED",
			errorClass: "leaked [redacted]",
			oneTx: true,
			unsettled: ["0xab"],
			steps: { bridge: 12 },
			waits: { epochProof: 1500 },
			sends: [{ step: "burn", txHash: "0xab" }],
			checks: [{ step: "selfTransfer", marginSec: "412", failed: ["margin"] }],
			burns: [{ txHash: "0xab", amount: "5" }],
		})
	})

	it("writes report.json 0600 with the outcome, timing a step that throws", async () => {
		const dir = scratchHome()
		const r = new CanaryReport(dir, { command: "canary", target: "own", l1ChainId: 11155111 })
		await expect(r.step("bridge", () => Promise.reject(new Error("x")))).rejects.toThrow("x")
		const path = r.finish(outcomeOf(new CanaryError("EPOCH_PROOF_TIMEOUT", "EPOCH_PROOF_TIMEOUT", "late")))
		expect(statSync(path).mode & 0o777).toBe(0o600)
		const written = JSON.parse(readFileSync(path, "utf8"))
		expect(written).toMatchObject({
			command: "canary",
			exitClass: "EPOCH_PROOF_TIMEOUT",
			exitCode: 3,
			steps: { bridge: expect.any(Number) },
		})
	})
})

describe("exit classes", () => {
	it("maps a pass to 0, a refusal to 2, an epoch-proof time-out to 3 and every other failure to 1", () => {
		const cases: [unknown, string, number, string | undefined][] = [
			[undefined, "PASS", 0, undefined],
			[new GuardError("argv", "bad"), "REFUSED", 2, "argv"],
			[new CanaryError("EPOCH_PROOF_TIMEOUT", "EPOCH_PROOF_TIMEOUT", "late"), "EPOCH_PROOF_TIMEOUT", 3, "EPOCH_PROOF_TIMEOUT"],
			[new CanaryError("I10_UNRESOLVED", "I10_UNRESOLVED", "dropped"), "I10_UNRESOLVED", 1, "I10_UNRESOLVED"],
			[new BridgeClientError("FEE_PATH_FAILED"), "FAILED", 1, "FEE_PATH_FAILED"],
			[new TypeError("library text"), "FAILED", 1, "TypeError"],
		]
		for (const [e, exitClass, exitCode, errorClass] of cases)
			expect(outcomeOf(e)).toEqual({ exitClass, exitCode, ...(errorClass === undefined ? {} : { errorClass }) })
	})
})
