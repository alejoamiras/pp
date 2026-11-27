// A PreparedSpend whose signals, noteData and context agree with each other and with its request,
// under anvil account 13's real keys. The proof points are dummies: checkSpend never verifies them.
import { BN254_SCALAR_MODULUS, EvmContextHashService, NoteComputationService, PoseidonHashService } from "@0xbow/privacy-pools-v2-sdk"
import { type Address, getAddress, type Hex, toHex } from "viem"
import { spendKeys } from "../../src/client.ts"
import { deriveKeys } from "../../src/keys.ts"
import type { Expected } from "../../src/spend-checks.ts"
import type { NoteData, PreparedSpend } from "../../src/types.ts"
import { anvilAccount, derivationSignature } from "./users.ts"

const ASSET = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3")
const PROCESSOR = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512")
const DATA: Hex = "0xc0ffee"
const word = (n: bigint) => toHex(n, { size: 32 })

export async function spendFixture() {
	const owner: Address = anvilAccount(13).address
	const signature = await derivationSignature(13)
	const { keystore, crypto } = deriveKeys(owner, signature)
	const hashService = await PoseidonHashService.create()
	const notes = new NoteComputationService({ hashService, cryptoService: crypto })
	const keys = spendKeys(owner, signature, notes)

	const label = 0xabcdefn
	const value = 100n
	const amount = 70n
	const spentCommitment = 0x1234n
	const changeSecret = word(0x3333n)
	const changeValue = toHex(value - amount)
	const noteAddressHash = notes.computeNoteAddressHash(owner, changeSecret)
	const precommitment = notes.computePrecommitment(noteAddressHash, ASSET, changeValue)
	const commitment = notes.computeFullCommitment({ noteAddressHash, tokenId: ASSET, value: changeValue, label: word(label) })
	const noteData: NoteData = notes.generateNoteData(
		{ noteSecret: changeSecret, value: changeValue, tokenId: ASSET, label: word(label) },
		keystore.getViewingKeyPair().publicKey,
	)
	const params = { processor: PROCESSOR, data: DATA }
	const context = BigInt(new EvmContextHashService().computeTransactContext(params, [noteData])) % BN254_SCALAR_MODULUS
	const nullifier = keys.nullifierOf(spentCommitment)
	const aspRoot = 13n

	const spend: PreparedSpend = {
		proof: {
			pA: [1n, 2n],
			pB: [
				[3n, 4n],
				[5n, 6n],
			],
			pC: [7n, 8n],
			pubSignals: [[nullifier], [BigInt(commitment)], [11n], [12n], [aspRoot], [amount], [BigInt(ASSET)], [context]],
		},
		noteData: [noteData],
		processor: PROCESSOR,
		data: DATA,
		nullifier,
		spentCommitment,
		change: { commitment: BigInt(commitment), precommitment: BigInt(precommitment), label, value: value - amount },
		amount,
		asset: ASSET,
		aspRoot,
	}
	const expected: Expected = { processor: PROCESSOR, data: DATA, amount, asset: ASSET, spentCommitment, label, value }
	return { spend, expected, params, keys, owner, notes, hashService, crypto }
}
