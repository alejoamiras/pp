import { type IGroth16Prover, LocalCircuitArtifacts, ProofService } from "#ppv2/evm-sdk"
import { createProver } from "@pp/pool-client"

/** Deposits prove on @pp/pool-client's prover, as spends do, so Bun's process-wide single-thread curve has one owner. */
export function createProofService(circuitsDir: string, prover: IGroth16Prover = createProver()): ProofService {
	return new ProofService({ circuitArtifacts: new LocalCircuitArtifacts({ baseDir: circuitsDir }), groth16Prover: prover })
}
