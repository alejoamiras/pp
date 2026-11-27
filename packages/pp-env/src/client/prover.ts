import { type IGroth16Prover, LocalCircuitArtifacts, ProofService } from "#ppv2/evm-sdk"
import { createProver } from "@pp/pool-client"

/**
 * Deposits prove through the checkout's ProofService on @pp/pool-client's prover, the one a user's
 * spends also take, so a user holds one curve (and Bun's single-thread workaround lives in one place).
 */
export function createProofService(circuitsDir: string, prover: IGroth16Prover = createProver()): ProofService {
	return new ProofService({ circuitArtifacts: new LocalCircuitArtifacts({ baseDir: circuitsDir }), groth16Prover: prover })
}
