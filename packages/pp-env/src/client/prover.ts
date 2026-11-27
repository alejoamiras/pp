import { type IGroth16Prover, ProofService } from "#ppv2/evm-sdk"
import { createArtifacts, createProver } from "@pp/pool-client"
import type { ClientConfig } from "./types.ts"

/**
 * Deposits prove on @pp/pool-client's prover and read its checked files, as spends do: Bun's process-wide
 * single-thread curve has one owner, and every circuit file is hashed against a pinned bundle before use.
 * @throws PoolClientError when the bundle is unknown or not allowed on `chainId`
 */
export function createProofService(
	c: Pick<ClientConfig, "circuitsDir" | "circuitBundle" | "chainId">,
	prover: IGroth16Prover = createProver(),
): ProofService {
	const bundle = c.circuitBundle
	const circuitArtifacts = createArtifacts(
		{ kind: "dir", path: c.circuitsDir, ...(bundle !== undefined && { bundle }) },
		{ chainId: c.chainId },
	)
	return new ProofService({ circuitArtifacts, groth16Prover: prover })
}
