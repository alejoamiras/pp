import { describe, expect, it } from "vitest"
import { FEE_FLOOR_WEI, FUNDING_GAS, fundingPlan, needOf } from "./funding"

describe("fundingPlan", () => {
	it("tops each key up to its budget at twice the fee, floored at 1 gwei, and counts the deployer's own budget in the total", () => {
		const fee = 3n
		const need = needOf("guardian", fee)
		expect(need).toBe(FUNDING_GAS.guardian * FEE_FLOOR_WEI * 2n)
		expect(needOf("guardian", 5n * FEE_FLOOR_WEI)).toBe(FUNDING_GAS.guardian * 10n * FEE_FLOOR_WEI)
		const plan = fundingPlan(
			[
				{ role: "guardian", address: "0x0000000000000000000000000000000000000001", balance: need + 1n },
				{ role: "canaryOwner", address: "0x0000000000000000000000000000000000000002", balance: 5n },
			],
			fee,
		)
		expect(plan.sends.map((s) => s.amount)).toEqual([0n, needOf("canaryOwner", fee) - 5n])
		expect(plan.total).toBe(needOf("l1Deployer", fee) + needOf("canaryOwner", fee) - 5n)
	})
})
