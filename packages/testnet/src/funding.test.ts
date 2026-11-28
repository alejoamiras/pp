import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import {
	assertTopUp,
	assertWithinLimits,
	FEE_FLOOR_WEI,
	feeAboveBudget,
	FUNDING_GAS,
	fundingPlan,
	liveGasOf,
	needOf,
	recipientsOf,
	staleSnapshot,
} from "./funding"
import { parseDeployment } from "./schema"

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const DEPLOYER = a(9)

describe("fundingPlan", () => {
	it("prices a role at its Prague budget times the live ratio measured for its kind of transaction", () => {
		expect(liveGasOf("poolDeployer")).toBe((FUNDING_GAS.poolDeployer * 767n) / 100n)
		expect(liveGasOf("l1Deployer")).toBe((FUNDING_GAS.l1Deployer * 767n) / 100n)
		expect(liveGasOf("guardian")).toBe((FUNDING_GAS.guardian * 501n) / 100n)
		expect(liveGasOf("canaryOwner")).toBe((FUNDING_GAS.canaryOwner * 501n) / 100n)
	})

	it("tops each key up to its budget at twice the fee, floored at 1 gwei, and counts the deployer's own budget in the total", () => {
		const fee = 3n
		const need = needOf("guardian", fee)
		expect(need).toBe(liveGasOf("guardian") * FEE_FLOOR_WEI * 2n)
		expect(needOf("guardian", 5n * FEE_FLOOR_WEI)).toBe(liveGasOf("guardian") * 10n * FEE_FLOOR_WEI)
		// Live Sepolia's estimate for a transfer that creates its recipient, against 21,000 for one that exists.
		const creating = 207_391n
		const plan = fundingPlan(
			DEPLOYER,
			[
				{ role: "guardian", address: a(1), balance: need + 1n, transferGas: 21_000n },
				{ role: "canaryOwner", address: a(2), balance: 0n, transferGas: creating },
			],
			fee,
		)
		expect(plan.sends.map((s) => s.amount)).toEqual([0n, needOf("canaryOwner", fee)])
		expect(plan.transferGas).toBe(creating * fee)
		expect(plan.total).toBe(needOf("l1Deployer", fee) + needOf("canaryOwner", fee) + creating * fee)
	})

	it("sends one top-up per address, for the summed needs of the roles it holds, and pays each top-up's gas", () => {
		const fee = 2n * FEE_FLOOR_WEI
		const shared = needOf("aspPostman", fee) + needOf("poolDeployer", fee)
		const plan = fundingPlan(
			DEPLOYER,
			[
				{ role: "poolDeployer", address: a(1), balance: 1n, transferGas: 21_000n },
				{ role: "aspPostman", address: a(1), balance: 1n, transferGas: 21_000n },
				{ role: "guardian", address: DEPLOYER, balance: 0n, transferGas: 21_000n },
			],
			fee,
		)
		expect(plan.sends.map((s) => [s.roles, s.amount])).toEqual([[["poolDeployer", "aspPostman"], shared - 1n]])
		expect(plan.deployerNeed).toBe(needOf("l1Deployer", fee) + needOf("guardian", fee))
		expect(plan.total).toBe(plan.deployerNeed + shared - 1n + 21_000n * fee)
	})
})

describe("a top-up within the owner's limits", () => {
	const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n
	const at = (o: { start?: number; now: number; sent?: number; amount: number }) => () =>
		assertWithinLimits({
			start: eth(o.start ?? 1.873),
			now: eth(o.now),
			sent: eth(o.sent ?? 0),
			amount: eth(o.amount),
			gasCost: eth(0.001),
		})

	it("goes while spending stays at most 0.8 ETH and the deployer keeps 1.0 ETH, counting a landed top-up and a pending one", () => {
		expect(at({ now: 1.6, sent: 0.27, amount: 0.4 })).not.toThrow()
		// The balance fell by 0.5 although the run thinks it sent 0.27: a top-up it judged lost had landed.
		expect(at({ now: 1.373, sent: 0.27, amount: 0.35 })).toThrow(/over its 0.8 ETH limit/)
		// The balance has not fallen yet, but the run already sent 0.6.
		expect(at({ now: 1.873, sent: 0.6, amount: 0.25 })).toThrow(/over its 0.8 ETH limit/)
		expect(at({ now: 1.2, sent: 0.67, amount: 0.1 })).not.toThrow()
		expect(at({ start: 1.1, now: 1.1, amount: 0.1 })).toThrow(/under its 1 ETH floor/)
		// The whole plan, before any send: today's quote passes, fresh keys' full budgets do not.
		expect(at({ now: 1.873, amount: 0.722886 })).not.toThrow()
		expect(at({ now: 1.873, amount: 0.849196 })).toThrow(/over its 0.8 ETH limit/)
	})
})

describe("a plan's snapshot block", () => {
	it.each([
		["holds every transaction both endpoints know", 5, 5, 5, false],
		["misses a top-up that landed after it", 5, 6, 6, true],
		["misses one still pending on the send endpoint", 5, 5, 6, true],
	])("%s", (_, atSnapshot, pendingRead, pendingSend, refused) => {
		const why = staleSnapshot({ block: 100n, atSnapshot, pendingRead, pendingSend })
		expect(why === undefined ? "planned" : why).toMatch(refused ? /at block 100 .*run again$/ : /^planned$/)
	})
})

describe("deploy-pool after a fund at the floor", () => {
	const funded = needOf("poolDeployer", FEE_FLOOR_WEI)
	it.each([
		["an estimate under the floor", FEE_FLOOR_WEI / 2n, funded, false],
		["an estimate at the floor", FEE_FLOOR_WEI, funded, false],
		["an estimate one wei above it", FEE_FLOOR_WEI + 1n, funded, true],
		["a balance one wei short at the floor", FEE_FLOOR_WEI, funded - 1n, true],
	])("starts at %s only if the balance covers its caps", (_, maxFeePerGas, balance, refused) => {
		expect(feeAboveBudget({ maxFeePerGas, balance }) ?? "starts").toMatch(refused ? /under the .* ETH .*wait/ : /^starts$/)
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

	it("adds each demo account the file names under the same rules: no zero address, one top-up per address", () => {
		const expected = { guardian: a(1), canaryOwner: a(2), canarySender: a(3) } as Parameters<typeof recipientsOf>[0]
		expect(() => recipientsOf({ ...expected, demoOwner: a(4), demoSender: a(0) })).toThrow("demoSender is the zero address")
		const fee = FEE_FLOOR_WEI
		const recipients = recipientsOf({ ...expected, demoOwner: a(4), demoSender: a(3) }).map((r) => ({
			...r,
			balance: 0n,
			transferGas: 21_000n,
		}))
		expect(fundingPlan(DEPLOYER, recipients, fee).sends.map((s) => [s.roles, s.need])).toEqual([
			[["guardian"], needOf("guardian", fee)],
			[["canaryOwner"], needOf("canaryOwner", fee)],
			[["canarySender", "demoSender"], needOf("canarySender", fee) + needOf("demoSender", fee)],
			[["demoOwner"], needOf("demoOwner", fee)],
		])
	})
})
