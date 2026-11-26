import type { Address, Hex, PublicClient } from "viem"
import { POOL_VAULT_ERRORS_ABI, POOL_VAULT_EVENTS_ABI, POOL_VAULT_TRANSACT_ABI } from "../client/abi.ts"
import type { LocalWallet, PreparedSpend } from "../client/pool.ts"

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

/**
 * Submits `spend.args` through `stub` from `wallet`, which can be anyone: the proof binds the
 * processor, not the sender. Reverts surface as viem errors naming the pool or stub error; a mined
 * transaction must have succeeded.
 */
export async function submitViaStub(wallet: LocalWallet, client: PublicClient, stub: Address, spend: PreparedSpend): Promise<Hex> {
	const hash = await wallet.writeContract({ address: stub, abi: STUB_PROCESSOR_ABI, functionName: "spend", args: spend.args })
	const receipt = await client.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`spend ${hash} reverted on chain`)
	return hash
}
