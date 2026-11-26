import { describe, expect, test } from "vitest"
import { BN254_P, parseAztecAddress, parseLabel, parseOrigin, parsePayee } from "./parse"

const PORTAL = "0x9047a1000000000000000000000000000000b1d9"
const hex64 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`
/** EIP-55's own test vectors. */
const MIXED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const DIGITS_AND_CAPS = "0x52908400098527886E0F7030069857D2E4169EE7"

const payee = (v: unknown, portal: `0x${string}` = PORTAL) => {
	const r = parsePayee(v, portal)
	return r.ok ? "ok" : r.reason
}

describe("input parsers", () => {
	test("an Aztec address is 32-byte hex below the field modulus, returned lower-cased", () => {
		const upper = `0x1C4F${"0".repeat(56)}E9B2`
		expect(parseAztecAddress(upper)).toBe(upper.toLowerCase())
		expect(parseAztecAddress({ toString: () => hex64(5n) })).toBe(hex64(5n))
		for (const bad of [hex64(BN254_P), `0x${"1".repeat(63)}`, "1c4f", "", null, 7, { toString: () => 1 }]) {
			expect(parseAztecAddress(bad), String(bad)).toBeNull()
		}
	})

	test("a payee passes only in its exact EIP-55 spelling, and never as zero or the portal", () => {
		expect([payee(MIXED), payee(DIGITS_AND_CAPS)]).toEqual(["ok", "ok"])
		expect(payee(MIXED.toLowerCase())).toBe("checksum")
		expect(payee(MIXED.replace("aAeb", "aaeb"))).toBe("checksum")
		expect(payee("0x0000000000000000000000000000000000000000")).toBe("zero")
		expect(payee(MIXED, MIXED.toLowerCase() as `0x${string}`)).toBe("portal")
		expect(payee("0x1234")).toBe("format")
	})

	test("a label is a field element and an origin is 0 or 1", () => {
		expect(parseLabel(BN254_P - 1n)).toBe(BN254_P - 1n)
		expect(parseLabel(hex64(42n))).toBe(42n)
		expect(parseLabel(BN254_P)).toBeNull()
		expect(parseLabel(-1n)).toBeNull()
		expect(parseLabel("0x")).toBeNull()
		expect([parseOrigin(0), parseOrigin(1n), parseOrigin(2), parseOrigin("1")]).toEqual([0, 1, null, null])
	})
})
