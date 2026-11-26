import type { Address, Hex, PublicClient } from "viem"
import type { LocalWallet, PreparedSpend } from "../client/types.ts"
import { STUB_PROCESSOR_ABI } from "./stub-abi.ts"

export { STUB_PROCESSOR_ABI }

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
