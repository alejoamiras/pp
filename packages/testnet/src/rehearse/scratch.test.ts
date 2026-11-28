import { describe, expect, it } from "vitest"
import { assertNoKeyIn } from "./scratch"

describe("assertNoKeyIn", () => {
	// A key with leading zero digits, as about a third of L2 secrets have.
	const key = `0x00${"c3".repeat(31)}`
	const value = BigInt(key)

	it("finds a key as padded hex, hex without its leading zeros and decimal, in any case", () => {
		for (const form of [key.toUpperCase().replace("0X", ""), value.toString(16), value.toString(10)])
			expect(() => assertNoKeyIn([`line\nsecret ${form}\n`], [key]), form).toThrow(/printed key 1 of 1/)
		expect(() => assertNoKeyIn([`0x00${"c4".repeat(31)}`], [key])).not.toThrow()
	})
})
