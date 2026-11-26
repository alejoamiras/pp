import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { Address, Hex } from "viem"
import { assertField, BN254_P, bytesToBigInt, hexBytes, SpecRangeError, word } from "./fields"

const utf8 = (s: string) => new TextEncoder().encode(s)

const CLAIM_KEY_INFO = utf8("pp.bridge/claim-key/v1")
const CLAIM_SALT_LABEL = utf8("pp.bridge/claim-salt/v1")

/** ECDSA `r` of a 64-byte (EIP-2098) or 65-byte signature: the same input the pool SDK's root derivation takes. */
function signatureR(signature: Hex): Uint8Array {
	const bytes = hexBytes(signature, 65) ?? hexBytes(signature, 64)
	if (bytes === undefined) throw new SpecRangeError("InvalidSignature", "signature")
	if (bytes.length === 65 && ![0, 1, 27, 28].includes(bytes[64] as number)) throw new SpecRangeError("InvalidSignature", "signature")
	const r = bytes.slice(0, 32)
	bytes.fill(0)
	if (r.every((b) => b === 0)) throw new SpecRangeError("InvalidSignature", "signature")
	return r
}

/**
 * The claim key: `HKDF-SHA256(ikm = r, salt = the 20 address bytes, info = "pp.bridge/claim-key/v1", 32)`.
 * A KDF only: the caller must already have checked that `signature` is the pool's secret-derivation
 * signature by `l1Address` over the pinned payload, or it derives a key the user cannot reproduce.
 * Never log or persist `signature` or the result.
 */
export function deriveClaimKey(signature: Hex, l1Address: Address): Uint8Array {
	const salt = hexBytes(l1Address, 20)
	// No value: `Hex` and `Address` are one type, so swapped arguments would put the signature here.
	if (salt === undefined) throw new SpecRangeError("InvalidAddress", "l1Address")
	const r = signatureR(signature)
	try {
		return hkdf(sha256, r, salt, CLAIM_KEY_INFO, 32)
	} finally {
		r.fill(0)
	}
}

/**
 * The claim salt for one bridge: `OS2IP(HKDF-SHA256(claimKey, "pp.bridge/claim-salt/v1", be32(spentCommitment), 64)) mod p`.
 * Deterministic yet unpredictable without the claim key, which keeps the recipient behind the public
 * secret hash as a random salt would. Changing either derivation is a new key version, never a regeneration.
 */
export function deriveClaimSalt(claimKey: Uint8Array, spentCommitment: bigint): bigint {
	if (!(claimKey instanceof Uint8Array) || claimKey.length !== 32) throw new SpecRangeError("InvalidKey", "claimKey")
	const info = word(assertField(spentCommitment, "spentCommitment", true))
	return bytesToBigInt(hkdf(sha256, claimKey, CLAIM_SALT_LABEL, info, 64)) % BN254_P
}

/**
 * The Inbox message's secret hash, `compute_secret_hash(derive_claim_secret(claimSalt, recipient))`.
 * Loads the Aztec mirror lazily: importing it initialises Barretenberg.
 */
export async function claimSecretHash(claimSalt: bigint, recipient: AztecAddress): Promise<bigint> {
	assertField(claimSalt, "claimSalt", true)
	const [{ tokenClaimSecretHash }, { Fr }] = await Promise.all([import("./claim-secret"), import("@aztec-labs/foundation/curves/bn254")])
	return (await tokenClaimSecretHash(new Fr(claimSalt), recipient)).toBigInt()
}
