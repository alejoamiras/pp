import { type ICircuitArtifacts, type IGroth16Prover, LocalCircuitArtifacts, ProofService } from "#ppv2/evm-sdk"
import { createArtifacts, createProver } from "@pp/pool-client"
import type { ClientConfig } from "./types.ts"

/**
 * Deposits prove on @pp/pool-client's prover, as spends do, so Bun's process-wide single-thread curve has one owner.
 * A named bundle reads the files through pool-client, hashed against that bundle as a spend's are.
 * @throws PoolClientError when the bundle is unknown or not allowed on `chainId`
 */
export function createProofService(
	c: Pick<ClientConfig, "circuitsDir" | "circuitBundle" | "chainId">,
	prover: IGroth16Prover = createProver(),
): ProofService {
	const circuitArtifacts: ICircuitArtifacts =
		c.circuitBundle === undefined
			? new LocalCircuitArtifacts({ baseDir: c.circuitsDir })
			: createArtifacts({ kind: "dir", path: c.circuitsDir, bundle: c.circuitBundle }, { chainId: c.chainId })
	return new ProofService({ circuitArtifacts, groth16Prover: prover })
}
