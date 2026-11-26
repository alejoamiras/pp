import { describe, expect, test } from "vitest"
import { labelView } from "./labels"

describe("label states", () => {
	test.each([
		[0, "ACTIVE", "Active", "ok", true],
		[1, "ACTIVE", "Active", "ok", true],
		[1, "ABSENT", "Awaiting approval", "wait", false],
		[0, "ABSENT", "Not in the allow list", "bad", false],
		[0, "STALE_ROOT", "List out of date", "wait", false],
		[1, "STALE_ROOT", "List out of date", "wait", false],
	] as const)("origin %i, %s reads %s; ragequit always open", (origin, state, text, tone, spends) => {
		const v = labelView(origin, state)
		expect([v.text, v.tone]).toEqual([text, tone])
		expect(v.can).toEqual({ send: spends, unshield: spends, ragequit: true })
		expect(v.reason === "").toBe(spends)
	})
})
