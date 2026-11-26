/**
 * A test wallet's answer to the handshake registry's interactive-handshake request: the recipient's
 * Schnorr signature over `[chain_id, version, registry, eph_pk.x]` with its message-signing key, plus
 * the keys that bind that key to its address (the registry's `RecipientSignature`). The embedded
 * wallet ships no such responder, so without one every interactive handshake fails.
 */
import type { CompleteAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { DomainSeparator } from "@aztec-labs/constants"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { Schnorr } from "@aztec-labs/foundation/crypto/schnorr"
import { INTERACTIVE_HANDSHAKE_REQUEST_KIND } from "@aztec-labs/standard-contracts/handshake-registry/constants"
import { deriveMasterMessageSigningSecretKey } from "@aztec-labs/stdlib/keys"
import type { PxeHooks } from "@pp/bridge-core/sandbox"

type ResolveCustomRequest = NonNullable<PxeHooks["resolveCustomRequest"]>

export interface HandshakeResponder {
	hooks: PxeHooks
	/** Starts answering for this account; until then every request is refused. */
	serve(secretKey: Fr, completeAddress: CompleteAddress): void
	/** The `eph_pk.x` of every handshake signed, in order (a simulation signs too): what a wallet must keep to find its notes. */
	signed: Fr[]
}

export function handshakeResponder(): HandshakeResponder {
	let account: { secretKey: Fr; completeAddress: CompleteAddress } | undefined
	const signed: Fr[] = []
	const resolveCustomRequest: ResolveCustomRequest = async (request) => {
		if (!request.kind.equals(INTERACTIVE_HANDSHAKE_REQUEST_KIND)) throw new Error(`unknown custom request ${request.kind}`)
		const [recipient, chainId, version, ephX] = request.payload
		if (!account || !recipient || !chainId || !version || !ephX) throw new Error("no account to sign for")
		if (!recipient.equals(account.completeAddress.address.toField())) throw new Error(`not this wallet's account: ${recipient}`)
		const mssk = deriveMasterMessageSigningSecretKey(account.secretKey)
		const schnorr = new Schnorr()
		const [mspkX, mspkYIsPositive] = (await schnorr.computePublicKey(mssk)).toXAndSign()
		const message = await poseidon2HashWithSeparator(
			[chainId, version, request.contractAddress.toField(), ephX],
			DomainSeparator.INTERACTIVE_HANDSHAKE_SIGNATURE,
		)
		const signature = await schnorr.constructSignature(message, mssk)
		signed.push(ephX)
		return [
			...account.completeAddress.publicKeys.toFields(),
			account.completeAddress.partialAddress,
			mspkX,
			new Fr(mspkYIsPositive ? 1n : 0n),
			...signature.toLimbFields(),
		]
	}
	return {
		hooks: { resolveCustomRequest },
		serve: (secretKey, completeAddress) => {
			account = { secretKey, completeAddress }
		},
		signed,
	}
}
