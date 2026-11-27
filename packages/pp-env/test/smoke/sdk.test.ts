import { expect, test } from "bun:test"
import {
	CryptoService,
	type Hex,
	MerkleService,
	NoteComputationService,
	PoseidonHashService,
	type Secret,
	WitnessPreparationService,
} from "#ppv2/evm-sdk"
import { startEvmMockAsp } from "#ppv2/mock-asp/evm"
import { createProofService } from "../../src/client/prover.ts"
import { checkout } from "../../src/env/checkout.ts"

test("both SDK entry points resolve through .ppv2", () => {
	expect(typeof startEvmMockAsp).toBe("function")
})

test(
	"proves and verifies a deposit under Bun, also after the curve slot is reset",
	async () => {
		const hashService = await PoseidonHashService.create()
		const merkleService = new MerkleService({ hashService })
		const noteComputationService = new NoteComputationService({ hashService, cryptoService: new CryptoService() })
		const witnesses = new WitnessPreparationService({ noteComputationService, hashService, merkleService })
		const proofs = createProofService({ circuitsDir: checkout().circuits, chainId: 31_337 })
		const witness = await witnesses.buildDepositWitness({
			noteAddressHash: noteComputationService.computeNoteAddressHash(
				"0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Hex,
				`0x${"ab".repeat(32)}` as Secret,
			),
			tokenId: "0x1" as Hex,
			value: "0x64" as Hex,
			context: "0xaaaaaaaaaaaaaaaa" as Hex,
			depositSecret: `0x${"98".repeat(32)}` as Secret,
		})
		expect(await proofs.verifyDeposit(await proofs.proveDeposit(witness))).toBe(true)
		// What a late-loading ffjavascript copy does to the slot.
		;(globalThis as { curve_bn128?: unknown }).curve_bn128 = null
		expect(await proofs.verifyDeposit(await proofs.proveDeposit(witness))).toBe(true)
	},
	{ timeout: 60_000 },
)
