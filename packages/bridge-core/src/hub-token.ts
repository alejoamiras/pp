/**
 * The L2 token instance a `TokenBridgeHub` derives for an ERC-20: the `LabelledToken` class,
 * `deployer = hub`, `salt = erc20`, initialized by `constructor(name, symbol, decimals, hub,
 * registry)` where name/symbol are the factory-attested words and `registry` is the hub's.
 * Pinned against the hub's in-circuit `derive_token` by fixed vectors; the class id is pinned
 * separately (`noir-artifact-classids.test.ts`).
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type ContractInstanceWithAddress, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { labelledTokenArtifact } from "./artifacts"
import { wordToNoirString } from "./register-hash"

export interface HubTokenWords {
	nameWord: string
	symbolWord: string
	decimals: number
}

export function hubTokenSalt(erc20: string): Fr {
	if (!/^0x[0-9a-fA-F]{40}$/.test(erc20)) throw new Error("erc20 must be a 20-byte hex address")
	return new Fr(BigInt(erc20))
}

/** The constructor args exactly as the hub enqueues them (the words as 31-char strings). */
export function hubTokenConstructorArgs(hub: AztecAddress, words: HubTokenWords, registry: AztecAddress): unknown[] {
	return [wordToNoirString(words.nameWord), wordToNoirString(words.symbolWord), words.decimals, hub, registry]
}

/**
 * The derivation binds the committed `LabelledToken` class; `tokenClassId` and `registry` are the
 * ones the hub was constructed with (the manifest's). A class mismatch derives addresses the hub
 * will never mint to, so it is refused rather than returned.
 */
export async function deriveHubTokenInstance(
	hub: AztecAddress,
	erc20: string,
	words: HubTokenWords,
	tokenClassId: string,
	registry: AztecAddress,
): Promise<ContractInstanceWithAddress> {
	const inst = await getContractInstanceFromInstantiationParams(labelledTokenArtifact, {
		constructorArgs: hubTokenConstructorArgs(hub, words, registry),
		constructorArtifact: "constructor",
		salt: hubTokenSalt(erc20),
		deployer: hub,
		publicKeys: PublicKeys.default(),
	})
	if (inst.currentContractClassId.toString() !== tokenClassId) {
		throw new Error(
			`hub token class mismatch: manifest says ${tokenClassId}, the committed LabelledToken derives ${inst.currentContractClassId.toString()}`,
		)
	}
	return inst
}
