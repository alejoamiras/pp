import "./shim.ts"

export { openPoolClient } from "./client.ts"
export { type HttpErrorClasses, pinnedOriginHttpClient } from "./http.ts"
export {
	type ArtifactFile,
	PoolClientError,
	type PoolClientErrorCode,
	type PoolClientErrorDetail,
	type SpendCheck,
} from "./errors.ts"
export { spendRevertCode } from "./fresh.ts"
export { SECRET_DERIVATION_PURPOSE, secretDerivationTypedData } from "./keys.ts"
export {
	type ArtifactSource,
	CIRCUIT_BUNDLES,
	type CircuitBundle,
	type CircuitBundleName,
	createArtifacts,
	type PinnedCircuit,
	type VerifiedArtifacts,
} from "./runtime/artifacts.ts"
export { createProver } from "./runtime/prover.ts"
export { type ProverPort, type WorkerProver, workerProver } from "./runtime/worker-prover.ts"
export type { IGroth16Prover } from "./sdk.ts"
export type {
	ChangeOpening,
	NoteData,
	NoteStatus,
	PoolClient,
	PoolConfig,
	PoolNoteView,
	PreparedSpend,
	RegistrationCall,
	RegistrationStep,
	SpendRequest,
	StaleRoot,
	TransactProof,
} from "./types.ts"
