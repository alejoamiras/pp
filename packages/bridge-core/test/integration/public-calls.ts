import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import type { Tx } from "@aztec-labs/aztec.js/tx"
import { FunctionSelector } from "@aztec-labs/stdlib/abi"

/** A public call request as a privacy check reads it: target, sender, and calldata led by the selector. */
export interface PublicCall {
	to: string
	from: string
	calldata: bigint[]
}

/** Every public call request `tx` enqueues, in order. */
export function publicCallsOf(tx: Tx): PublicCall[] {
	return tx.getPublicCallRequestsWithCalldata().map((c) => ({
		to: c.request.contractAddress.toString(),
		from: c.request.msgSender.toString(),
		calldata: c.calldata.map((f) => f.toBigInt()),
	}))
}

/**
 * The selector of public function `name` in `artifact`, as a public call request's first calldata
 * field carries it. A transpiled artifact lists public functions apart from `functions`.
 */
export async function selectorOf(artifact: ContractArtifact, name: string): Promise<bigint> {
	const f = artifact.nonDispatchPublicFunctions.find((x) => x.name === name)
	if (!f) throw new Error(`the artifact declares no ${name}`)
	return (await FunctionSelector.fromNameAndParameters(f.name, f.parameters)).toField().toBigInt()
}
