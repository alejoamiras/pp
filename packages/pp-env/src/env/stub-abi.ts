import { POOL_VAULT_ERRORS_ABI, POOL_VAULT_EVENTS_ABI, POOL_VAULT_TRANSACT_ABI } from "../client/abi.ts"

const [transact] = POOL_VAULT_TRANSACT_ABI

/** `StubProcessor`: `spend` takes `transact`'s arguments verbatim; pool errors bubble through it. */
export const STUB_PROCESSOR_ABI = [
	{ ...transact, name: "spend" },
	{
		type: "function",
		name: "lastSpend",
		stateMutability: "view",
		inputs: [],
		outputs: [
			{ name: "asset", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "nullifier", type: "uint256" },
			{ name: "changeCommitment", type: "uint256" },
		],
	},
	{ type: "function", name: "spendCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
	{
		type: "event",
		name: "Processed",
		inputs: [
			{ name: "nullifier", type: "uint256", indexed: true },
			{ name: "changeCommitment", type: "uint256", indexed: false },
			{ name: "asset", type: "address", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "data", type: "bytes", indexed: false },
		],
	},
	{
		type: "error",
		name: "NotOneInOneOut",
		inputs: [
			{ name: "nullifiers", type: "uint256" },
			{ name: "commitments", type: "uint256" },
		],
	},
	{ type: "error", name: "UnexpectedToken", inputs: [{ name: "tokenIdOut", type: "uint256" }] },
	{
		type: "error",
		name: "PaymentMismatch",
		inputs: [
			{ name: "expected", type: "uint256" },
			{ name: "received", type: "uint256" },
		],
	},
	...POOL_VAULT_ERRORS_ABI,
	...POOL_VAULT_EVENTS_ABI,
] as const
