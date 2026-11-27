import { expect, test } from "vitest"
import { missingCases } from "./check-cases"

const report = (...a: [string, string][]) => ({ testResults: [{ assertionResults: a.map(([title, status]) => ({ title, status })) }] })

test("a case passes only when every test carrying its id passed; skipped, todo and absent ones fail", () => {
	const r = report(["D0 the attached stack", "passed"], ["D1a second generation", "skipped"], ["D10 is not D1", "passed"])
	expect(missingCases(["D0"], [r])).toEqual([])
	expect(missingCases(["D1a", "D1b", "D1"], [r])).toEqual(["D1a: skipped", "D1b: not run", "D1: not run"])
	expect(missingCases(["L1"], [r, report(["L1 read-back failed", "todo"])])).toEqual(["L1: todo"])
})
