import { toHex } from "viem"
import { expect, it } from "vitest"
import { deriveKeys } from "../../src/keys.ts"
import { openNoteData } from "../../src/note-data.ts"
import { spendFixture } from "../support/spend-fixture.ts"
import { anvilAccount, derivationSignature } from "../support/users.ts"

it("opens the change noteData for its owner, and for nobody else", async () => {
	const fx = await spendFixture()
	const own = deriveKeys(fx.owner, await derivationSignature(13))
	const opened = openNoteData(fx.spend.noteData[0]!, {
		notes: fx.notes,
		crypto: own.crypto,
		viewingPrivateKey: own.keystore.getViewingKeyPair().privateKey,
		owner: fx.owner,
	})
	expect(opened?.opening).toEqual(fx.spend.change)
	const { precommitment, label, commitment } = opened!.opening
	expect(BigInt(fx.hashService.hash([toHex(precommitment, { size: 32 }), toHex(label, { size: 32 })]))).toBe(commitment)

	const stranger = anvilAccount(12).address
	const theirs = deriveKeys(stranger, await derivationSignature(12))
	const viewingPrivateKey = theirs.keystore.getViewingKeyPair().privateKey
	expect(openNoteData(fx.spend.noteData[0]!, { notes: fx.notes, crypto: theirs.crypto, viewingPrivateKey, owner: stranger })).toBeNull()
})
