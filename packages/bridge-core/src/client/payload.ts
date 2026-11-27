import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import {
	type ContractArtifact,
	encodeArguments,
	FunctionCall,
	FunctionSelector,
	getFunctionArtifactByName,
	getFunctionReturnType,
} from "@aztec-labs/stdlib/abi"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { ExecutionPayload, mergeExecutionPayloads } from "@aztec-labs/stdlib/tx"

let fpc: Promise<AztecAddress> | undefined

/** The canonical SponsoredFPC's address, derived from its artifact and salt as the local network and testnet deploy it. */
export function sponsoredFpcAddress(): Promise<AztecAddress> {
	fpc ??= getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) }).then(
		(i) => i.address,
	)
	return fpc
}

/**
 * `p` with the SponsoredFPC's payment merged in. A wallet takes the fee payer from the payload, so
 * whichever wallet sends it, the FPC pays: the payer is public, and a holder paying their own fee
 * would link the account to what it sends. Holds only where a SponsoredFPC is deployed.
 */
export async function sponsored(p: ExecutionPayload): Promise<ExecutionPayload> {
	const fee = await new SponsoredFeePaymentMethod(await sponsoredFpcAddress()).getExecutionPayload()
	return mergeExecutionPayloads([fee, p])
}

/** One call to `name` on `to`, its arguments encoded against `artifact`, as aztec.js would build it without a wallet. */
export async function callPayload(artifact: ContractArtifact, to: AztecAddress, name: string, args: unknown[]): Promise<ExecutionPayload> {
	const fn = getFunctionArtifactByName(artifact, name)
	const call = FunctionCall.from({
		name: fn.name,
		to,
		selector: await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters),
		type: fn.functionType,
		hideMsgSender: false,
		isStatic: fn.isStatic,
		args: encodeArguments(fn, args),
		returnType: getFunctionReturnType(fn),
	})
	return new ExecutionPayload([call], [], [])
}
