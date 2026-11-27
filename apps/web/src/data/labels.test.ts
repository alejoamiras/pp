import { describe, expect, test } from "vitest"
import { labelView, listFailureView } from "./labels"

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
			// An absence is the server's claim, so it never advises a public exit.
			expect(`${v.text} ${v.meaning} ${v.reason}`).not.toMatch(/leave|ragequit|ethereum|exit/i)
			expect(v.tone).not.toBe("bad")
		}
		expect(labelView(0, "ABSENT").checkAgain).toBe(true)
	})

	test("each way a list can fail to be checked has its own words, none of them the stale root's", () => {
		const codes = ["LIST_TIMEOUT", "LIST_MISMATCH", "LIST_OVERSIZED", "LIST_CANCELLED", "LIST_UNAVAILABLE"] as const
		const views = codes.map(listFailureView)
		const stale = labelView(0, "STALE_ROOT")
		for (const key of ["text", "meaning"] as const) {
			const said = views.map((v) => v[key])
			expect(new Set(said).size).toBe(codes.length)
			expect(said).not.toContain(stale[key])
		}
		for (const v of views) expect(v.can).toEqual({ send: false, unshield: false, ragequit: true })
		// Only a list a refresh reads again offers no manual Check again.
		expect(views.map((v) => v.checkAgain)).toEqual([true, true, true, true, false])
	})
})
