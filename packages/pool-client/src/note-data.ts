import { type Address, getAddress } from "viem"
import { type CryptoService, decodeNoteData, type Hex, type NoteComputationService } from "./sdk.ts"
import type { ChangeOpening, NoteData } from "./types.ts"

export type NoteOpener = { notes: NoteComputationService; crypto: CryptoService; viewingPrivateKey: Hex; owner: Address }

/** Decrypts a `Note` payload addressed to `owner`'s viewing key; `null` when it is not ours or is malformed. */
export function openNoteData(noteData: NoteData, o: NoteOpener): { opening: ChangeOpening; asset: Address } | null {
	try {
		const { ephemeralPubKey, encryptedPayload } = decodeNoteData(noteData.data)
		const payload = o.notes.decodeNotePayload(o.crypto.decrypt(encryptedPayload, o.crypto.ecdh(o.viewingPrivateKey, ephemeralPubKey)))
		const noteAddressHash = o.notes.computeNoteAddressHash(o.owner, payload.noteSecret)
		const precommitment = o.notes.computePrecommitment(noteAddressHash, payload.tokenId, payload.value)
		const commitment = o.notes.computeFullCommitment({
			noteAddressHash,
			tokenId: payload.tokenId,
			value: payload.value,
			label: payload.label,
		})
		return {
			opening: {
				commitment: BigInt(commitment),
				precommitment: BigInt(precommitment),
				label: BigInt(payload.label),
				value: BigInt(payload.value),
			},
			asset: getAddress(payload.tokenId),
		}
	} catch {
		return null
	}
}
