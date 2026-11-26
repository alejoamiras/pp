import { describe, expect, it } from "vitest"
import { assertSame } from "./script-l1"

describe("script-l1", () => {
	it("assertSame is case-insensitive and throws with both values on mismatch", () => {
		expect(() => assertSame("0xAB", "0xab", "x")).not.toThrow()
		expect(() => assertSame("0x01", "0x02", "portal.registry")).toThrow(/portal\.registry - on-chain 0x01 != expected 0x02/)
	})
})
