// The only module that imports values from the SDK. Its typings declare exports the 1.0.2 bundle lacks,
// and some module loaders turn a missing export into `undefined` instead of a link error, so check here.
import {
	DEFAULT_CIRCUIT_MANIFEST,
	Groth16Prover,
	IpfsCircuitArtifacts,
	LocalCircuitArtifacts,
	ProofService,
} from "@0xbow/privacy-pools-v2-sdk"

export const SDK_VALUES = {
	DEFAULT_CIRCUIT_MANIFEST,
	Groth16Prover,
	IpfsCircuitArtifacts,
	LocalCircuitArtifacts,
	ProofService,
} as const

const missing = Object.entries(SDK_VALUES)
	.filter(([, v]) => v === undefined)
	.map(([k]) => k)
if (missing.length > 0) throw new Error(`@0xbow/privacy-pools-v2-sdk does not export ${missing.join(", ")} at run time`)

export { DEFAULT_CIRCUIT_MANIFEST, Groth16Prover, IpfsCircuitArtifacts, LocalCircuitArtifacts, ProofService }
export type { CircuitArtifactCIDs, ICircuitArtifacts, IGroth16Prover, IHTTPClient } from "@0xbow/privacy-pools-v2-sdk"
