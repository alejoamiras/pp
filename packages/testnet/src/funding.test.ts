import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { assertTopUp, FEE_FLOOR_WEI, FUNDING_GAS, fundingPlan, needOf, recipientsOf, TRANSFER_GAS } from "./funding"
import { parseDeployment } from "./schema"

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const DEPLOYER = a(9)

describe("fundingPlan", () => {
	it("tops each key up to its budget at twice the fee, floored at 1 gwei, and counts the deployer's own budget in the total", () => {
		const fee = 3n
		const need = needOf("guardian", fee)
		expect(need).toBe(FUNDING_GAS.guardian * FEE_FLOOR_WEI * 2n)
		expect(needOf("guardian", 5n * FEE_FLOOR_WEI)).toBe(FUNDING_GAS.guardian * 10n * FEE_FLOOR_WEI)
		const plan = fundingPlan(
			DEPLOYER,
			[
				{ role: "guardian", address: a(1), balance: need + 1n },
				{ role: "canaryOwner", address: a(2), balance: 5n },
			],
			fee,
		)
		expect(plan.sends.map((s) => s.amount)).toEqual([0n, needOf("canaryOwner", fee) - 5n])
		expect(plan.total).toBe(needOf("l1Deployer", fee) + needOf("canaryOwner", fee) - 5n + TRANSFER_GAS * fee)
	})

	it("sends one top-up per address, for the summed needs of the roles it holds, and pays each top-up's gas", () => {
		const fee = 2n * FEE_FLOOR_WEI
		const shared = needOf("aspPostman", fee) + needOf("poolDeployer", fee)
		const plan = fundingPlan(
			DEPLOYER,
			[
				{ role: "poolDeployer", address: a(1), balance: 1n },
				{ role: "aspPostman", address: a(1), balance: 1n },
				{ role: "guardian", address: DEPLOYER, balance: 0n },
			],
			fee,
		)
		expect(plan.sends.map((s) => [s.roles, s.amount])).toEqual([[["poolDeployer", "aspPostman"], shared - 1n]])
		expect(plan.deployerNeed).toBe(needOf("l1Deployer", fee) + needOf("guardian", fee))
		expect(plan.total).toBe(plan.deployerNeed + shared - 1n + TRANSFER_GAS * fee)
	})
})

describe("a top-up's receipt", () => {
	const sent = `0x${"aa".repeat(32)}` as Hex
	const receipt = { transactionHash: sent, status: "success", from: DEPLOYER }

	it("is the sent transaction's, from the deployer, and succeeded", () => {
		expect(() => assertTopUp(receipt, sent, DEPLOYER)).not.toThrow()
		const replacement = `0x${"bb".repeat(32)}` as Hex
		expect(() => assertTopUp({ ...receipt, transactionHash: replacement }, sent, DEPLOYER)).toThrow(
			new RegExp(`${sent}.*${replacement}`),
		)
		expect(() => assertTopUp({ ...receipt, status: "reverted" }, sent, DEPLOYER)).toThrow(/did not succeed/)
	})
})

describe("the deployment file's addresses", () => {
	it("refuse the zero address, so no top-up can go to it", () => {
		const own = JSON.parse(readFileSync(fileURLToPath(new URL("../deployments/testnet-own.json", import.meta.url)), "utf8"))
		const word = `0x${"11".repeat(32)}`
		const expected = {
			...{ guardian: a(1), lifetimeCap: "1", l1Deployer: a(2), l2Deployer: word, botPoster: word, aspPostman: a(3) },
			...{ poolDeployer: a(4), canaryOwner: a(5), canarySender: a(6), birthIntake: word, tokenClassId: word },
			amounts: { debit: "1", note: "1", bridge: "1" },
		}
		expect(parseDeployment({ ...own, expected }).expected?.guardian).toBe(a(1))
		expect(() => parseDeployment({ ...own, expected: { ...expected, guardian: a(0) } })).toThrow(/expected.guardian: the zero address/)
	})
})

describe("recipientsOf", () => {
	it("refuses a zero-address role even when the file's parse was skipped", () => {
		const expected = { guardian: a(0), canaryOwner: a(2), canarySender: a(3) } as Parameters<typeof recipientsOf>[0]
		expect(() => recipientsOf(expected)).toThrow("guardian is the zero address")
		expect(recipientsOf({ ...expected, guardian: a(1) }).map((r) => r.role)).toEqual(["guardian", "canaryOwner", "canarySender"])
	})
})
