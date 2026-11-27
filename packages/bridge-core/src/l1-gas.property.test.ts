import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { sendGasLimit } from "./l1-gas"

// Small estimates hit every remainder mod 4, where the rounding happens; large ones probe overflow-free bigint math.
const estimate = fc.oneof(fc.bigInt({ min: 0n, max: 400n }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }))

describe("sendGasLimit", () => {
	const headroom = propertyParams(import.meta.url, "the limit is the smallest integer at or above 125% of the estimate", 300, 2_000)
	it(
		"the limit is the smallest integer at or above 125% of the estimate",
		() => {
			fc.assert(
				fc.property(estimate, (e) => {
					const limit = sendGasLimit(e)
					expect(100n * limit).toBeGreaterThanOrEqual(125n * e)
					expect(125n * e).toBeGreaterThan(100n * (limit - 1n))
				}),
				headroom.fc,
			)
		},
		headroom.testTimeout,
	)
})
