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

export const POOL_VAULT_ERRORS_ABI = [
	{ type: "error", name: "PoolVault_InvalidProcessor", inputs: [] },
	{ type: "error", name: "PoolVault_ProofContextMismatch", inputs: [] },
	{ type: "error", name: "PoolVault_InvalidASPRoot", inputs: [] },
	{ type: "error", name: "PoolVault_NullifierAlreadySpent", inputs: [] },
	{ type: "error", name: "PoolVault_CommitmentAlreadyUsed", inputs: [] },
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
