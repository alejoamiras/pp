import { describe, expect, it } from "vitest"
import { formatAmount, labelHex, shortHex } from "./format"

describe("formatAmount", () => {
	it.each([
		[1_000_000_000n, 6, "1,000.00"],
		[1_239_999n, 6, "1.23"],
		[10_000n, 6, "0.01"],
		[9_999n, 6, "0.0099"],
		[5_000n, 6, "0.005"],
		[1n, 18, "0.000000000000000001"],
		[0n, 18, "0.00"],
		[7n, 2, "0.07"],
		[1_000n, 0, "1,000"],
	])("%s at %i decimals reads %s: truncated from 0.01 up, two significant digits below", (value, decimals, text) => {
		expect(formatAmount(value, decimals)).toBe(text)
	})
})

describe("labelHex and shortHex", () => {
	it("spell a label at full width, then shorten it", () => {
		const hex = labelHex(0x2f9cn)
		expect(hex).toBe(`0x${"0".repeat(60)}2f9c`)
		expect(shortHex(hex)).toBe("0x0000…2f9c")
		expect(shortHex("0x2f9c")).toBe("0x2f9c")
	})
})
