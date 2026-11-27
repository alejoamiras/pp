import { describe, expect, test } from "vitest"
import { labelView } from "./labels"

describe("label states", () => {
	test.each([
		[0, "ACTIVE", "Active", "ok", true],
		[1, "ACTIVE", "Active", "ok", true],
		[1, "ABSENT", "Awaiting approval", "wait", false],
		[0, "ABSENT", "Not found in the latest list", "attn", false],
		[0, "STALE_ROOT", "List out of date", "wait", false],
		[1, "STALE_ROOT", "List out of date", "wait", false],
	] as const)("origin %i, %s reads %s; ragequit always open", (origin, state, text, tone, spends) => {
		const v = labelView(origin, state)
		expect([v.text, v.tone]).toEqual([text, tone])
		expect(v.can).toEqual({ send: spends, unshield: spends, ragequit: true })
		expect(v.reason === "").toBe(spends)
	})

	test("ABSENT is the server's claim: it never reads as a removal, and a bridged label offers a fresh read", () => {
		for (const origin of [0, 1] as const) {
			const v = labelView(origin, "ABSENT")
			expect(`${v.text} ${v.meaning} ${v.reason}`).not.toMatch(/revoked|removed/i)
			expect(v.tone).not.toBe("bad")
		}
		expect(labelView(0, "ABSENT").checkAgain).toBe(true)
	})
})
