import type { ContractFunctionArgs } from "viem"

// The SDK's typings declare its ABI constants, but its bundles do not export them at runtime, so
// these are ours, pinned to the compiled PoolVault by abi.test.ts.

export const POOL_VAULT_TRANSACT_ABI = [
	{
		type: "function",
		name: "transact",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "_proof",
				type: "tuple",
				components: [
					{ name: "pA", type: "uint256[2]" },
					{ name: "pB", type: "uint256[2][2]" },
					{ name: "pC", type: "uint256[2]" },
					{ name: "pubSignals", type: "uint256[][]" },
				],
			},
			{
				name: "_transactParams",
				type: "tuple",
				components: [
					{ name: "processor", type: "address" },
					{ name: "data", type: "bytes" },
				],
			},
			{
				name: "_noteData",
				type: "tuple[]",
				components: [
					{ name: "hint", type: "bytes32" },
					{ name: "data", type: "bytes" },
				],
			},
		],
		outputs: [],
	},
] as const

/**
 * Every error the compiled PoolVault can revert with, its own and those of the libraries and proxy
 * it inherits, so any revert from `transact` decodes by name.
 */
export const POOL_VAULT_ERRORS_ABI = [
	{ type: "error", name: "AddressEmptyCode", inputs: [{ name: "target", type: "address" }] },
	{ type: "error", name: "EnforcedPause", inputs: [] },
	{ type: "error", name: "ERC1967InvalidImplementation", inputs: [{ name: "implementation", type: "address" }] },
	{ type: "error", name: "ERC1967NonPayable", inputs: [] },
	{ type: "error", name: "ExpectedPause", inputs: [] },
	{ type: "error", name: "FailedCall", inputs: [] },
	{ type: "error", name: "InvalidInitialization", inputs: [] },
	{ type: "error", name: "NotInitializing", inputs: [] },
	{ type: "error", name: "Permissioned_InvalidAccessRouter", inputs: [] },
	{ type: "error", name: "Permissioned_NotAuthorized", inputs: [] },
	{ type: "error", name: "PoolVault_CommitmentAlreadyUsed", inputs: [] },
	{ type: "error", name: "PoolVault_CommitmentNotFound", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidASPRoot", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidDepositProof", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidMaxTreeSize", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidOwnerAddress", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidProcessor", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidRagequitProof", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidTransactProof", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidValue", inputs: [] },
	{ type: "error", name: "PoolVault_NullifierAlreadySpent", inputs: [] },
	{ type: "error", name: "PoolVault_ProofContextMismatch", inputs: [] },
	{ type: "error", name: "PoolVault_StateTreeFull", inputs: [] },
	{ type: "error", name: "PoolVault_TokenIdMustBeZeroOnInternalTransfer", inputs: [] },
	{ type: "error", name: "PoolVault_UnexpectedETHAmount", inputs: [] },
	{ type: "error", name: "PoolVault_UnknownKeystoreRoot", inputs: [] },
	{ type: "error", name: "PoolVault_UnknownStateRoot", inputs: [] },
	{ type: "error", name: "PoolVault_ZeroValueRagequit", inputs: [] },
	{ type: "error", name: "ProofLib_TokenIdNotCanonical", inputs: [{ name: "_raw", type: "uint256" }] },
	{ type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
	{ type: "error", name: "RootBuffer_InvalidSize", inputs: [] },
	{ type: "error", name: "TransactVerifierRouter_InvalidZeroParameter", inputs: [] },
	{
		type: "error",
		name: "TransactVerifierRouter_UnsupportedCircuitConfiguration",
		inputs: [
			{ name: "_nullifiersSpent", type: "uint256" },
			{ name: "_commitmentsCreated", type: "uint256" },
		],
	},
	{ type: "error", name: "TransactVerifierRouter_VerifierCallReverted", inputs: [{ name: "_error", type: "bytes" }] },
	{ type: "error", name: "UUPSUnauthorizedCallContext", inputs: [] },
	{ type: "error", name: "UUPSUnsupportedProxiableUUID", inputs: [{ name: "slot", type: "bytes32" }] },
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
	{
		type: "event",
		name: "LeavesInserted",
		inputs: [
			{ name: "_newLeaves", type: "uint256[]", indexed: false },
			{ name: "_root", type: "uint256", indexed: false },
			{ name: "_startIndex", type: "uint256", indexed: false },
		],
	},
] as const

export const TRANSACT_ABI = [...POOL_VAULT_TRANSACT_ABI, ...POOL_VAULT_ERRORS_ABI, ...POOL_VAULT_EVENTS_ABI] as const

/** `PoolVault.transact(proof, params, noteData)`, exactly as a processor must forward it. */
export type TransactArgs = ContractFunctionArgs<typeof POOL_VAULT_TRANSACT_ABI, "nonpayable", "transact">
