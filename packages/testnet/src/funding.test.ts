import { describe, expect, it } from "vitest"
import { FUNDING_GAS, fundingPlan, needOf } from "./funding"

describe("fundingPlan", () => {
	it("tops each key up to its budget at twice the fee and counts the deployer's own budget in the total", () => {
		const fee = 3n
		const need = needOf("guardian", fee)
		expect(need).toBe(FUNDING_GAS.guardian * fee * 2n)
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
