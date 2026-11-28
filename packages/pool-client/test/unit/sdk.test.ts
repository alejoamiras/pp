import { expect, it } from "vitest"
import { type ICircuitArtifacts, type IGroth16Prover, ProofService, SDK_VALUES } from "../../src/sdk.ts"
import { offlineTransactWitness } from "../support/offline-witness.ts"

it("every SDK value this package imports is defined at run time", () => {
	const missing = Object.entries(SDK_VALUES).filter(([, v]) => v === undefined)
	expect(missing).toEqual([])
})

it("a proof the prover could not make leaves the SDK as an error named ProofGenerationFailed, the name callers read", async () => {
	const { witness } = await offlineTransactWitness()
	const empty = async () => new Uint8Array()
	const files: ICircuitArtifacts = { getWasm: empty, getProvingKey: empty, getVerificationKey: empty }
	const prover: IGroth16Prover = { fullProve: () => Promise.reject(new Error("prover worker terminated")), verify: async () => false }
	const proofs = new ProofService({ circuitArtifacts: files, groth16Prover: prover })
	const failed = await proofs.proveTransact(witness as never, 1, 1).catch((err: unknown) => err)
	expect(failed).toBeInstanceOf(Error)
	expect((failed as Error).name).toBe("ProofGenerationFailed")
})
