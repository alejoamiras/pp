// A self-consistent transact_1x1 witness with no chain: the input note is the only state leaf, its label's
// hash the only ASP leaf, and the owner's keystore leaf is taken as pending, so it is the whole keystore tree.
import {
	COMMITMENT_LEAF_TAG,
	CryptoService,
	type Hex,
	MerkleService,
	NoteComputationService,
	NoteStatus,
	PoseidonHashService,
	WitnessPreparationService,
} from "@0xbow/privacy-pools-v2-sdk"
import { toHex } from "viem"

const OWNER: Hex = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
const ASSET: Hex = "0x5fbdb2315678afecb367f032d93f642f64180aa3"
const field = (n: bigint): Hex => toHex(n, { size: 32 })

export type OfflineSpend = {
	witness: Record<string, unknown>
	nullifier: bigint
	changeCommitment: bigint
	amount: bigint
	asset: bigint
	context: bigint
}

export async function offlineTransactWitness(): Promise<OfflineSpend> {
	const hashService = await PoseidonHashService.create()
	const notes = new NoteComputationService({ hashService, cryptoService: new CryptoService() })
	const witnesses = new WitnessPreparationService({
		noteComputationService: notes,
		hashService,
		merkleService: new MerkleService({ hashService }),
	})
	const nullifyingKey = field(0x1111n)
	const value = 100n
	const amount = 70n
	const label = field(0xabcdefn)
	const context = 0x0c0ffeen

	const noteSecret = field(0x2222n)
	const noteAddressHash = notes.computeNoteAddressHash(OWNER, noteSecret)
	const commitment = notes.computeFullCommitment({ noteAddressHash, tokenId: ASSET, value: toHex(value), label })
	const createdAtBlock = toHex(100)
	const changeSecret = field(0x3333n)
	const changeAddressHash = notes.computeNoteAddressHash(OWNER, changeSecret)
	const changeValue = toHex(value - amount)
	const changeCommitment = notes.computeFullCommitment({ noteAddressHash: changeAddressHash, tokenId: ASSET, value: changeValue, label })
	const base = { tokenId: ASSET, label, ownerAddress: OWNER, isOwned: true }

	const witness = await witnesses.buildTransactWitness({
		inputNotes: [
			{
				...base,
				noteAddressHash,
				commitment,
				value: toHex(value),
				noteSecret,
				status: NoteStatus.ACTIVE,
				createdAtBlock,
				spentAtBlock: null,
				txHash: field(1n),
			},
		],
		changeNotes: [
			{
				...base,
				noteAddressHash: changeAddressHash,
				commitment: changeCommitment,
				value: changeValue,
				noteSecret: changeSecret,
				status: NoteStatus.PENDING,
			},
		],
		recipientNotes: [],
		ownerAddress: OWNER,
		privateNullifyingKey: nullifyingKey,
		privateRevocableKey: field(0x4444n),
		tokenId: ASSET,
		amountOut: toHex(amount),
		tokenIdOut: ASSET,
		context: toHex(context),
		stateLeaves: [hashService.hash([COMMITMENT_LEAF_TAG, commitment, createdAtBlock])],
		keystoreLeaves: [],
		aspLeaves: [notes.computeLabelHash(label)],
		pendingKeystoreRegistration: true,
	})

	return {
		witness: witness as unknown as Record<string, unknown>,
		nullifier: BigInt(notes.computeNullifier(nullifyingKey, commitment)),
		changeCommitment: BigInt(changeCommitment),
		amount,
		asset: BigInt(ASSET),
		context,
	}
}
