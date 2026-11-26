import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { drift, type Gates, overBudget } from "../scripts/gates"

const bench = (name: string): Gates => JSON.parse(readFileSync(join(import.meta.dirname, "../bench", name), "utf8")) as Gates

describe("gate budgets", () => {
	test("every measured private function has a budget and stays within it", () => {
		expect(overBudget(bench("gates.json"), bench("budget.json"))).toEqual([])
	})

	test("the checks report what they should", () => {
		expect(overBudget({ f: 11 }, { f: 10 })).toEqual(["f: 11 gates, budget 10"])
		expect(overBudget({ f: 1 }, {})).toEqual(["f: no budget"])
		expect(overBudget({}, { f: 1 })).toEqual(["f: budgeted, not measured"])
		expect(drift({ f: 1 }, { g: 1 })).toHaveLength(2)
		expect(drift({ f: 1 }, { f: 1 })).toEqual([])
	})
})
