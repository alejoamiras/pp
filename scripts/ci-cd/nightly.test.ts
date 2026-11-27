import { expect, test } from "bun:test"
import { forgePassed, SUITES, verdict, vitestPassed } from "../nightly"

const forgeSuite = SUITES[0]

test("a nightly suite fails when it exits non-zero or passes no test", () => {
	const ran = "Suite result: ok. 3 passed; 0 failed; 0 skipped\nSuite result: ok. 1 passed; 0 failed; 0 skipped"
	expect(forgePassed(ran)).toBe(4)
	expect(verdict(forgeSuite, 0, ran)).toBeUndefined()
	expect(verdict(forgeSuite, 0, "No tests match the provided pattern")).toBe(`${forgeSuite.name}: matched no test`)
	expect(verdict(forgeSuite, 1, ran)).toBe(`${forgeSuite.name}: exited 1`)
})

test("a vitest suite counts only its summary's passed tests, colored or not", () => {
	const colored = "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m (1)\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m | \u001b[33m3 skipped\u001b[39m (4)"
	expect(vitestPassed(colored)).toBe(1)
	expect(vitestPassed("      Tests  1 failed | 2 passed (3)")).toBe(2)
	expect(vitestPassed("      Tests  4 skipped (4)")).toBe(0)
})

test("suite names are unique", () => {
	expect(new Set(SUITES.map((s) => s.name)).size).toBe(SUITES.length)
})
