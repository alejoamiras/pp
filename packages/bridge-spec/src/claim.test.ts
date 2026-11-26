import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type Hex, parseSignature, serializeCompactSignature, signatureToCompactSignature } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { claimSecretHash, deriveClaimKey, deriveClaimSalt } from "./claim"
import { BN254_P, bytesToBigInt, hexBytes, SpecRangeError, toHex, word } from "./fields"

const utf8 = (s: string) => new TextEncoder().encode(s)

/** Independent oracle: WebCrypto HKDF-SHA256. */
async function webHkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	// Copies onto a plain ArrayBuffer, which WebCrypto's BufferSource requires.
	const key = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"])
	const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) }
	return new Uint8Array(await crypto.subtle.deriveBits(params, key, bytes * 8))
}

const bytes = (hex: string) => hexBytes(hex, (hex.length - 2) / 2) as Uint8Array

// anvil's well-known key #0; viem signs deterministically (RFC 6979).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
const SIGNATURE: Hex =
	"0x712edcdd09524fe4ce0ac3fba02426730abfc32218b1a82bfedec950605c6f561ec3d62cf1cf16043763d27df05f829ec637eedc121b3fe277891934b6509fcc1b"
// Frozen outputs: a change to either derivation is a new key version, so these never regenerate.
const CLAIM_KEY = "0x207a0f87439edcfbefde314a3630319b463818f39a5821a715d7fd0cd7926211"
const CLAIM_SALT_0x1234 = 0x19b609a5a38bbb2c60a6557ffbcf122e38f47bd32260a1117fb458d5cf56378bn

describe("HKDF", () => {
	it("the oracle and @noble/hashes reproduce RFC 5869 test case 1", async () => {
		const ikm = new Uint8Array(22).fill(0x0b)
		const salt = bytes("0x000102030405060708090a0b0c")
		const info = bytes("0xf0f1f2f3f4f5f6f7f8f9")
		const okm = "0x3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
		expect(toHex(await webHkdf(ikm, salt, info, 42))).toBe(okm)
		expect(toHex(hkdf(sha256, ikm, salt, info, 42))).toBe(okm)
	})
})

describe("claim key and salt", () => {
	it("the fixture is the signature viem produces today", async () => {
		expect(await account.signMessage({ message: "pp.bridge spec test" })).toBe(SIGNATURE)
	})

	it("the 65-byte forms with v 27/28 and 0/1 and the EIP-2098 compact form give one key", () => {
		const parsed = parseSignature(SIGNATURE)
		const v01 = `${SIGNATURE.slice(0, 130)}${(Number(parsed.v) - 27).toString(16).padStart(2, "0")}` as Hex
		const compact = serializeCompactSignature(signatureToCompactSignature(parsed))
		for (const sig of [SIGNATURE, v01, compact]) expect(toHex(deriveClaimKey(sig, account.address))).toBe(CLAIM_KEY)
	})

	it("key and salt equal WebCrypto HKDF over the documented inputs, mod p", async () => {
		const r = bytes(SIGNATURE.slice(0, 66))
		const key = await webHkdf(r, bytes(account.address), utf8("pp.bridge/claim-key/v1"), 32)
		expect(toHex(key)).toBe(CLAIM_KEY)
		const okm = await webHkdf(key, utf8("pp.bridge/claim-salt/v1"), word(0x1234n), 64)
		expect(bytesToBigInt(okm) % BN254_P).toBe(CLAIM_SALT_0x1234)
		expect(deriveClaimSalt(bytes(CLAIM_KEY), 0x1234n)).toBe(CLAIM_SALT_0x1234)
	})

	it("the address enters as raw bytes, so its checksum case does not matter", () => {
		expect(toHex(deriveClaimKey(SIGNATURE, account.address.toLowerCase() as Hex))).toBe(CLAIM_KEY)
	})

	it("the secret hash equals the claim-secret keystone vector", async () => {
		expect(await claimSecretHash(1n, AztecAddress.fromBigIntUnsafe(2n))).toBe(
			0x1ce9b36531e066f21da630794455329ccf900519a6873e7c9b710b245979ecdcn,
		)
	})
})

describe("rejections never echo a secret", () => {
	const code = async (f: () => unknown) => {
		try {
			await f()
		} catch (e) {
			if (!(e instanceof SpecRangeError)) throw e
			return e
		}
		throw new Error("no error")
	}
	const sigBody = SIGNATURE.slice(2, 130)
	const withV = (v: string) => `0x${sigBody}${v}` as Hex
	const zeroR = `0x${"00".repeat(32)}${SIGNATURE.slice(66)}` as Hex
	const secretNeedle = "5ec4e7"
	const secretBig = BigInt(`0x${secretNeedle}`) + BN254_P

	it.each([
		["v = 29", () => deriveClaimKey(withV("1d"), account.address), "InvalidSignature", sigBody.slice(0, 16)],
		["63 bytes", () => deriveClaimKey(`0x${sigBody.slice(2)}` as Hex, account.address), "InvalidSignature", sigBody.slice(2, 18)],
		["non-hex", () => deriveClaimKey(withV("zz"), account.address), "InvalidSignature", sigBody.slice(0, 16)],
		["r = 0", () => deriveClaimKey(zeroR, account.address), "InvalidSignature", SIGNATURE.slice(66, 82)],
		["a 31-byte key", () => deriveClaimSalt(bytes(CLAIM_KEY).slice(1), 1n), "InvalidKey", CLAIM_KEY.slice(4, 20)],
		["spent commitment ≥ p", () => deriveClaimSalt(bytes(CLAIM_KEY), secretBig), "FieldOutOfRange", secretBig.toString(16)],
		["claim salt ≥ p", () => claimSecretHash(secretBig, AztecAddress.fromBigIntUnsafe(2n)), "FieldOutOfRange", secretBig.toString(16)],
	])("%s", async (_, f, want, needle) => {
		const err = await code(f)
		expect(err.code).toBe(want)
		expect(err.value).toBeUndefined()
		const decimal = secretBig.toString()
		for (const text of [err.message, String(err), JSON.stringify(err), String(err.cause ?? "")]) {
			expect(text.toLowerCase()).not.toContain(needle.toLowerCase())
			expect(text).not.toContain(decimal)
		}
	})

	it("swapped arguments are refused without echoing the signature", async () => {
		const err = await code(() => deriveClaimKey(account.address, SIGNATURE))
		expect([err.code, err.value]).toEqual(["InvalidAddress", undefined])
		for (const text of [err.message, String(err), JSON.stringify(err)]) expect(text).not.toContain(sigBody.slice(0, 16))
	})
})
