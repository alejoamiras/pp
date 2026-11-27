import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"

/** The node read the check needs; structural so a test can stand in for the node. */
export type HubClassReader = {
	getContract(address: AztecAddress): Promise<{ currentContractClassId: { toString(): string } } | undefined>
}

export class LegacyHubError extends Error {
	constructor(reason: string) {
		super(`refusing to open entries: ${reason}`)
		this.name = "LegacyHubError"
	}
}

/**
 * Entries may open only behind a v1 hub. A pool spend into a generation whose hub cannot consume
 * `bridge_content_v1` commits the nullifier and leaves the funds behind a message nobody can claim,
 * and a portal clone has no sweep. The class id pins every byte of the hub's bytecode, so the
 * deployed instance must carry the class the committed v1 artifact derives; `claim_from_pool` in
 * that artifact is the name that proves a bridged note can be claimed.
 */
export async function assertV1Hub(node: HubClassReader, hub: AztecAddress, artifact: ContractArtifact): Promise<void> {
	if (!artifact.functions.some((f) => f.name === "claim_from_pool")) throw new LegacyHubError("the hub artifact has no claim_from_pool")
	const expected = (await getContractClassFromArtifact(artifact)).id.toString()
	const deployed = await node.getContract(hub)
	if (!deployed) throw new LegacyHubError(`no contract at ${hub.toString()}`)
	const actual = deployed.currentContractClassId.toString()
	if (actual !== expected) throw new LegacyHubError(`hub class ${actual} is not the v1 class ${expected}`)
}
