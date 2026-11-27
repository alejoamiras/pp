import { hashTypedData, parseSignature, serializeCompactSignature, signatureToCompactSignature, slice } from "viem"
import { describe, expect, it } from "vitest"
import { deriveKeys, normaliseSignature, secretDerivationTypedData, verifySigner } from "../../src/keys.ts"
import { anvilAccount, derivationSignature } from "../support/users.ts"

const user = anvilAccount(13)

describe("the user's signature", () => {
	it("gives the same keys in its 65-byte and 64-byte compact forms", async () => {
		const full = await derivationSignature(13)
		const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(full)))
		expect(normaliseSignature(compact)).toBe(full)
		await verifySigner(user.address, normaliseSignature(compact))
		const a = deriveKeys(user.address, full).keystore
		const b = deriveKeys(user.address, normaliseSignature(compact)).keystore
		expect(b.getPrivateNullifyingKey()).toBe(a.getPrivateNullifyingKey())
		expect(b.getViewingKeyPair().publicKey).toBe(a.getViewingKeyPair().publicKey)
	})

	it("refuses other lengths, another signer, and another message, without echoing the signature", async () => {
		const full = await derivationSignature(13)
		const short = slice(full, 0, 63)
		expect(() => normaliseSignature(short)).toThrow(expect.objectContaining({ code: "SIGNATURE_INVALID" }))
		await expect(verifySigner(user.address, await derivationSignature(12))).rejects.toMatchObject({ code: "SIGNATURE_INVALID" })
		const other = await user.signMessage({ message: "something else" })
		const err = await verifySigner(user.address, other).catch((e: Error) => e)
		expect(err).toMatchObject({ code: "SIGNATURE_INVALID" })
		expect(String(err?.message)).not.toContain(other.slice(2, 20))
	})

	it("signs the digest pp-env signs for the same address", () => {
		expect(hashTypedData(secretDerivationTypedData(user.address))).toBe(
			"0x649ff4ae9aa6f35d3cbf3656097f6b42142ecba0016ecbc3d3bfc92ac42bdc52",
		)
	})
})
