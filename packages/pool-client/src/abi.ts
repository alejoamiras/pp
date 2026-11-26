// Ours, not the SDK's: its 1.0.2 bundle lacks several declared ABI constants. Pinned to the compiled
// contracts by test/proof/abi.test.ts.

const error = <const N extends string>(name: N) => ({ type: "error", name, inputs: [] }) as const

export const POOL_VAULT_ERRORS_ABI = [
	error("PoolVault_CommitmentAlreadyUsed"),
	error("PoolVault_CommitmentNotFound"),
	error("PoolVault_InvalidASPRoot"),
	error("PoolVault_InvalidDepositProof"),
	error("PoolVault_InvalidMaxTreeSize"),
	error("PoolVault_InvalidOwnerAddress"),
	error("PoolVault_InvalidProcessor"),
	error("PoolVault_InvalidRagequitProof"),
	error("PoolVault_InvalidTransactProof"),
	error("PoolVault_InvalidValue"),
	error("PoolVault_NullifierAlreadySpent"),
	error("PoolVault_ProofContextMismatch"),
	error("PoolVault_StateTreeFull"),
	error("PoolVault_TokenIdMustBeZeroOnInternalTransfer"),
	error("PoolVault_UnexpectedETHAmount"),
	error("PoolVault_UnknownKeystoreRoot"),
	error("PoolVault_UnknownStateRoot"),
	error("PoolVault_ZeroValueRagequit"),
] as const

export const POOL_VAULT_EVENTS_ABI = [
	{
		type: "event",
		name: "Transacted",
		inputs: [
			{ name: "outputCommitments", type: "uint256[]", indexed: false },
			{ name: "nullifierHashes", type: "uint256[]", indexed: false },
			{ name: "asset", type: "address", indexed: true },
			{ name: "withdrawnValue", type: "uint256", indexed: false },
			{ name: "caller", type: "address", indexed: true },
		],
	},
	{
		type: "event",
		name: "Note",
		inputs: [
			{ name: "hint", type: "bytes32", indexed: true },
			{ name: "data", type: "bytes", indexed: false },
		],
	},
] as const

export const POOL_VAULT_VIEWS_ABI = [
	{
		type: "function",
		name: "isKnownRoot",
		inputs: [{ name: "_root", type: "uint256" }],
		outputs: [{ name: "_isKnown", type: "bool" }],
		stateMutability: "view",
	},
] as const

export const KEYSTORE_VIEWS_ABI = [
	{ type: "function", name: "currentRoot", inputs: [], outputs: [{ name: "_root", type: "uint256" }], stateMutability: "view" },
	{
		type: "function",
		name: "previousRoots",
		inputs: [{ name: "_root", type: "uint256" }],
		outputs: [{ name: "_validUntil", type: "uint256" }],
		stateMutability: "view",
	},
] as const

export const ASP_REGISTRY_VIEWS_ABI = [
	{ type: "function", name: "latestASPRoot", inputs: [], outputs: [{ name: "_root", type: "uint256" }], stateMutability: "view" },
] as const
