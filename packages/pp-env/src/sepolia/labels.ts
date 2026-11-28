import { MerkleService, NoteComputationService, PoseidonHashService, utils } from "#ppv2/core-sdk"
import { CryptoService } from "#ppv2/evm-sdk"
import { concat, type Hex, hexToBytes, keccak256, toHex } from "viem"

/** Exposes the SDK's own RFC 7748 clamping and X25519 derivation, which ECDH with a depositor's ephemeral key expects. */
class AspCrypto extends CryptoService {
	pairFrom(raw: Uint8Array): { privateKey: Hex; publicKey: Hex } {
		return this.keyPairFromBytes(raw) as { privateKey: Hex; publicKey: Hex }
	}
}

const KEY_DOMAIN = toHex("pp-env/sepolia mock ASP X25519 v1")

/** The SDK services label recovery and the association-set tree need, built once. */
export type Labels = {
	readonly publicKey: Hex
	/**
	 * The label a deposit's ASP ciphertext names, accepted only when it rebuilds `commitment`, the one
	 * the vault inserted in that transaction: a ciphertext naming any other note is refused.
	 * @throws Error when the ciphertext does not decrypt under this key or names another note
	 */
	labelOf(ciphertext: Hex, commitment: bigint): bigint
	/** A label's association-set leaf, Poseidon(label). */
	leafOf(label: bigint): bigint
	/** The association-set root over these leaves, in this order. */
	rootOf(leaves: readonly bigint[]): Promise<bigint>
}

/**
 * The X25519 pair is a pure function of the postman key: a restarted ASP decrypts every deposit its
 * predecessor approved and rebuilds the same set from the chain alone.
 */
export async function createLabels(postmanKey: Hex): Promise<Labels> {
	const crypto = new AspCrypto()
	const keys = crypto.pairFrom(hexToBytes(keccak256(concat([KEY_DOMAIN, postmanKey]))))
	const hashService = await PoseidonHashService.create()
	const notes = new NoteComputationService({ hashService, cryptoService: crypto })
	const merkle = new MerkleService({ hashService })
	return {
		publicKey: keys.publicKey,
		labelOf(ciphertext, commitment) {
			// Only `utils` carries the decoder at run time, though the declarations list it at the top level too.
			const p = utils.decodeASPCipherText(ciphertext, { aspPrivateKey: keys.privateKey }, { cryptoService: crypto })
			// The EVM address-to-field conversion is the identity, so the payload's tokenId is already the field.
			const precommitment = notes.computePrecommitment(p.noteAddressHash, p.tokenId, p.value)
			const label = notes.computeLabel(precommitment, p.depositSecret)
			const rebuilt = notes.computeFullCommitment({ noteAddressHash: p.noteAddressHash, tokenId: p.tokenId, value: p.value, label })
			if (BigInt(rebuilt) !== commitment) throw new Error("the ciphertext names a note other than the one deposited")
			return BigInt(label)
		},
		leafOf: (label) => BigInt(notes.computeLabelHash(toHex(label))),
		async rootOf(leaves) {
			return BigInt(await merkle.computeRoot(leaves.map((l) => toHex(l))))
		},
	}
}
