import { type ContractArtifact, decodeFunctionSignature, type EventMetadataDefinition, EventSelector } from "@aztec-labs/stdlib/abi"

/**
 * An event's decoder metadata, taken from the artifact's ABI: a change to the event's fields moves
 * its selector with it, where a hand-written signature would silently match nothing.
 */
export async function eventMeta(artifact: ContractArtifact, name: string): Promise<EventMetadataDefinition> {
	const abiType = artifact.outputs.structs.events?.find((e) => e.kind === "struct" && e.path.endsWith(`::${name}`))
	if (abiType?.kind !== "struct") throw new Error(`${artifact.name} has no event ${name}`)
	const signature = decodeFunctionSignature(
		name,
		abiType.fields.map((f) => ({ ...f, visibility: "private" as const })),
	)
	return { eventSelector: await EventSelector.fromSignature(signature), abiType, fieldNames: abiType.fields.map((f) => f.name) }
}
