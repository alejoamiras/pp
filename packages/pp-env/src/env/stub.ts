import { type Address, type Hex, isAddressEqual, type PublicClient, parseEventLogs } from "viem"
import type { LocalWallet, PreparedSpend } from "../client/types.ts"
import { STUB_PROCESSOR_ABI } from "./stub-abi.ts"

export { STUB_PROCESSOR_ABI }

/**
 * Submits `spend.args` through `stub` from `wallet`, which can be anyone: the proof binds the
 * processor, not the sender. Reverts surface as viem errors naming the pool or stub error. Success
 * means the stub itself reported processing this spend's nullifier: a call to an address with no
 * code also mines successfully.
 */
export async function submitViaStub(wallet: LocalWallet, client: PublicClient, stub: Address, spend: PreparedSpend): Promise<Hex> {
	const hash = await wallet.writeContract({ address: stub, abi: STUB_PROCESSOR_ABI, functionName: "spend", args: spend.args })
	const receipt = await client.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`spend ${hash} reverted on chain`)
	const processed = parseEventLogs({ abi: STUB_PROCESSOR_ABI, eventName: "Processed", logs: receipt.logs }).some(
		(log) => isAddressEqual(log.address, stub) && log.args.nullifier === spend.nullifier,
	)
	if (!processed) throw new Error(`spend ${hash} mined, but ${stub} did not process it`)
	return hash
}
