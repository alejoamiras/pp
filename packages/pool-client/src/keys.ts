import {
	type Address,
	compactSignatureToSignature,
	type Hex,
	keccak256,
	parseCompactSignature,
	serializeSignature,
	size,
	toHex,
	verifyTypedData,
	zeroAddress,
} from "viem"
import { PoolClientError } from "./errors.ts"
import { APP_IDENTIFIER, CryptoService, KeystoreManager } from "./sdk.ts"

/** Part of the signed hash, and so of every derived key: it must never change by a byte. */
export const SECRET_DERIVATION_PURPOSE =
	"This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas."

/**
 * The EIP-712 payload whose signature roots the user's pool keys and claim key. The SDK leaves it to the
 * integrator; this one equals the pinned upstream sample app's, so a wallet signing either derives the same keys.
 */
export function secretDerivationTypedData(l1Address: Address) {
	return {
		domain: {
			name: "Standardized Secret Derivation",
			version: "1",
			verifyingContract: zeroAddress,
			salt: keccak256(toHex(APP_IDENTIFIER)),
		},
		types: {
			SecretDerivation: [
				{ name: "purpose", type: "string" },
				{ name: "addressHash", type: "bytes32" },
			],
		},
		primaryType: "SecretDerivation",
		message: { purpose: SECRET_DERIVATION_PURPOSE, addressHash: keccak256(l1Address) },
	} as const
}

const invalid = (why: string) => new PoolClientError("SIGNATURE_INVALID", why)

/** 65-byte `r‖s‖v`, or the 64-byte EIP-2098 compact form, as 65 bytes. Never echoes the input. */
export function normaliseSignature(signature: Hex): Hex {
	let length: number
	try {
		length = size(signature)
	} catch {
		throw invalid("not hex")
	}
	if (length === 65) return signature
	if (length !== 64) throw invalid(`${length} bytes; expected 64 or 65`)
	try {
		return serializeSignature(compactSignatureToSignature(parseCompactSignature(signature)))
	} catch {
		throw invalid("malformed compact signature")
	}
}

/** The SDK never recovers the signer, so without this a foreign signature opens an unrelated, empty key set. */
export async function verifySigner(l1Address: Address, signature: Hex): Promise<void> {
	let valid = false
	try {
		valid = await verifyTypedData({ address: l1Address, signature, ...secretDerivationTypedData(l1Address) })
	} catch {
		throw invalid("unreadable signature")
	}
	if (!valid) throw invalid("not made by this address over the secret-derivation payload")
}

export type Keys = { keystore: KeystoreManager; crypto: CryptoService }

/** A fresh key set from the signature; no state is shared with any other derivation. */
export function deriveKeys(l1Address: Address, signature: Hex): Keys {
	const crypto = new CryptoService()
	const keystore = KeystoreManager.fromSignature(
		{ signature, signerAddress: l1Address, addressHash: keccak256(l1Address), revocableKeyIndex: "0x0" },
		{ cryptoService: crypto },
	)
	return { keystore, crypto }
}
