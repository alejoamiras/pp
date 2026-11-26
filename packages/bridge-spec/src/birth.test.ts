import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { describe, expect, it } from "vitest"
import {
	birthId,
	birthLabel,
	birthNullifier,
	DOM_SEP__PP_BIRTH_ID,
	DOM_SEP__PP_BIRTH_LABEL,
	DOM_SEP__PP_BIRTH_NULLIFIER,
	siloedBirthNullifier,
} from "./birth"
import { BN254_P, SpecRangeError, U128_MAX } from "./fields"
import { tagWord } from "./tags"

const token = AztecAddress.fromBigIntUnsafe(0x7001n)
const owner = AztecAddress.fromBigIntUnsafe(0x0e01n)
const birthSecret = 0x5ec0n

describe("birth hashes", () => {
	it("the separators are the ASCII words pbl1, pbn1, pbi1", () => {
		expect([DOM_SEP__PP_BIRTH_LABEL, DOM_SEP__PP_BIRTH_NULLIFIER, DOM_SEP__PP_BIRTH_ID].map(BigInt)).toEqual(
			["pbl1", "pbn1", "pbi1"].map(tagWord),
		)
	})

	// Frozen: the Noir `pp_hash::birth` tests and the shared vectors pin the same values.
	it("pins label′, the inner and siloed nullifiers and birth_id", async () => {
		const label = birthLabel({ token, owner, amount: 1_000_000n, birthSecret })
		expect(label).toBe(0x1dbf894b632234f02d6cd78fe19f8c444b803861174b337c408a4f7928831d18n)
		expect(birthNullifier({ owner, birthSecret })).toBe(0x74a84c1a9e6c8067e55ed0f2f9dae9add95e290f670240d3c1948a77097ae36n)
		expect(await siloedBirthNullifier({ token, owner, birthSecret })).toBe(
			0x21cb9b4a4aa712a1146e4ae2fcee22c3a026478a38765180970396ab564bbbe9n,
		)
		expect(birthId({ label, birthSecret })).toBe(0x11bac41f6aee342ca7df5b45f6ee20ac2fca368a1c982b10d818ba4ab586726bn)
	})

	it("each input moves label′", () => {
		const base = birthLabel({ token, owner, amount: 1n, birthSecret })
		const other = AztecAddress.fromBigIntUnsafe(0x9n)
		for (const changed of [{ token: other }, { owner: other }, { amount: 2n }, { birthSecret: birthSecret + 1n }]) {
			expect(birthLabel({ token, owner, amount: 1n, birthSecret, ...changed })).not.toBe(base)
		}
	})

	const reject = (f: () => unknown) => {
		try {
			f()
		} catch (e) {
			if (e instanceof SpecRangeError) return e
			throw e
		}
		throw new Error("no error")
	}

	it("refuses an amount above u128 and a label ≥ p", () => {
		expect(reject(() => birthLabel({ token, owner, amount: U128_MAX + 1n, birthSecret })).code).toBe("AmountOutOfRange")
		expect(reject(() => birthId({ label: BN254_P, birthSecret })).code).toBe("FieldOutOfRange")
	})

	it("a birth secret ≥ p is refused without echoing it", () => {
		const secret = BN254_P + 0x5ec4e7n
		for (const f of [() => birthNullifier({ owner, birthSecret: secret }), () => birthId({ label: 1n, birthSecret: secret })]) {
			const err = reject(f)
			expect([err.code, err.value]).toEqual(["FieldOutOfRange", undefined])
			for (const text of [err.message, JSON.stringify(err)]) {
				expect(text).not.toContain(secret.toString())
				expect(text).not.toContain(secret.toString(16))
			}
		}
	})
})
