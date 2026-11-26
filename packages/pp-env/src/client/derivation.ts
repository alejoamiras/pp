import { APP_IDENTIFIER } from "#ppv2/evm-sdk"
import { type Address, keccak256, toHex, zeroAddress } from "viem"
import type { SecretDerivationTypedData } from "./types.ts"

/** Part of the signed hash, and so of every derived key: it must never change by a byte. */
export const SECRET_DERIVATION_PURPOSE: string =
	"This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas."

/**
 * The EIP-712 "Standardized Secret Derivation" payload whose signature roots a user's protocol keys.
 * The SDK leaves building it to the integrator; this matches the pinned upstream sample app, so a
 * wallet signing either derives the same keys.
 */
export function secretDerivationTypedData(signer: Address): SecretDerivationTypedData {
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
		message: { purpose: SECRET_DERIVATION_PURPOSE, addressHash: keccak256(signer) },
	} as const
}
