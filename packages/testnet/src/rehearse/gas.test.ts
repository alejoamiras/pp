import { describe, expect, it } from "vitest"
import { FUNDING_GAS } from "../funding"
import { budgetCheck } from "./gas"

describe("budgetCheck", () => {
	it("holds the demo owner's measured spend to its budget", () => {
		const demo = "0x00000000000000000000000000000000000000De"
		const gas = new Map<string, bigint>([[demo.toLowerCase(), FUNDING_GAS.demoOwner]])
		expect(budgetCheck(gas, { DEMO_OWNER_KEY: demo }).demoOwner).toBe(FUNDING_GAS.demoOwner)
		gas.set(demo.toLowerCase(), FUNDING_GAS.demoOwner + 1n)
		expect(() => budgetCheck(gas, { DEMO_OWNER_KEY: demo })).toThrow(/^demoOwner spent/)
	})
})
