import { expect, test } from "bun:test"
import { forgePassed, SUITES, verdict } from "../nightly"

const forgeSuite = SUITES[0]

test("a nightly suite fails when it exits non-zero or passes no test", () => {
	const ran = "Suite result: ok. 3 passed; 0 failed; 0 skipped\nSuite result: ok. 1 passed; 0 failed; 0 skipped"
	expect(forgePassed(ran)).toBe(4)
	expect(verdict(forgeSuite, 0, ran)).toBeUndefined()
	expect(verdict(forgeSuite, 0, "No tests match the provided pattern")).toBe(`${forgeSuite.name}: matched no test`)
	expect(verdict(forgeSuite, 1, ran)).toBe(`${forgeSuite.name}: exited 1`)
})

test("suite names are unique", () => {
	expect(new Set(SUITES.map((s) => s.name)).size).toBe(SUITES.length)
})
