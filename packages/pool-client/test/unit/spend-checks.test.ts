import { getAddress, type Hex } from "viem"
import { beforeAll, describe, expect, it } from "vitest"
import { checkSpend, type Expected, type TransactParams } from "../../src/spend-checks.ts"
import type { PreparedSpend } from "../../src/types.ts"
import { spendFixture } from "../support/spend-fixture.ts"

type Fixture = Awaited<ReturnType<typeof spendFixture>>
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] }
type Case = { spend?: (s: Mutable<PreparedSpend>) => void; params?: (p: TransactParams) => void; expected?: (e: Expected) => void }

const OTHER = getAddress("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0")
const flip = (hex: Hex, at: number): Hex => {
	const i = 2 + at * 2
	return `${hex.slice(0, i)}${((Number.parseInt(hex.slice(i, i + 2), 16) ^ 1) & 0xff).toString(16).padStart(2, "0")}${hex.slice(i + 2)}` as Hex
}

let fx: Fixture
beforeAll(async () => {
	fx = await spendFixture()
})

function run(c: Case): void {
	const spend = structuredClone(fx.spend) as Mutable<PreparedSpend>
	const params = { ...fx.params }
	const expected = { ...fx.expected }
	c.spend?.(spend)
	c.params?.(params)
	c.expected?.(expected)
	checkSpend(spend as PreparedSpend, params, expected, fx.keys)
}

describe("checkSpend", () => {
	it("passes a spend that agrees with its request, keys, noteData and context", () => {
		expect(() => run({})).not.toThrow()
	})

	it.each<[string, Case]>([
		["shape", { spend: (s) => s.proof.pubSignals.pop() }],
		["shape", { spend: (s) => s.noteData.push(s.noteData[0]!) }],
		["request", { expected: (e) => (e.processor = OTHER) }],
		["params", { params: (p) => (p.processor = OTHER) }],
		["params", { params: (p) => (p.data = "0xc0ffef") }],
		["public", { spend: (s) => (s.proof.pubSignals[5]![0] = 71n) }],
		["public", { spend: (s) => (s.proof.pubSignals[6]![0] = BigInt(OTHER)) }],
		["public", { spend: (s) => (s.aspRoot = 14n) }],
		["nullifier", { spend: (s) => (s.proof.pubSignals[0]![0] = 1n) }],
		["change", { spend: (s) => (s.noteData[0]!.data = flip(s.noteData[0]!.data, 40)) }],
		["change", { spend: (s) => (s.change.value = 31n) }],
		["change", { expected: (e) => (e.value = 101n) }],
		["context", { spend: (s) => (s.proof.pubSignals[7]![0] = 1n) }],
	])("fails %s", (check, c) => {
		expect(() => run(c)).toThrow(expect.objectContaining({ code: "SPEND_CHECK_FAILED", check }))
	})
})
