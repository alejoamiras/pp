import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { describe, expect, it } from "vitest"
import { tokenBridgeHubArtifact } from "../../src/artifacts"
import { assertV1Hub, type HubClassReader, LegacyHubError } from "./v1-hub"

const HUB = AztecAddress.fromBigIntUnsafe(0xb5n)
const nodeWith = (classId: string | undefined): HubClassReader => ({
	getContract: async () => (classId === undefined ? undefined : { currentContractClassId: { toString: () => classId } }),
})

describe("assertV1Hub", () => {
	it("passes only when the deployed class is the committed v1 artifact's", async () => {
		const v1 = (await getContractClassFromArtifact(tokenBridgeHubArtifact)).id.toString()
		await expect(assertV1Hub(nodeWith(v1), HUB, tokenBridgeHubArtifact)).resolves.toBeUndefined()
		await expect(assertV1Hub(nodeWith(`0x${"11".repeat(32)}`), HUB, tokenBridgeHubArtifact)).rejects.toThrow(LegacyHubError)
		await expect(assertV1Hub(nodeWith(undefined), HUB, tokenBridgeHubArtifact)).rejects.toThrow(LegacyHubError)
	})

	it("refuses a legacy-shaped artifact before reading the node", async () => {
		const legacy = {
			...tokenBridgeHubArtifact,
			functions: tokenBridgeHubArtifact.functions.filter((f) => f.name !== "claim_from_pool"),
		}
		let read = false
		const node: HubClassReader = {
			getContract: async () => {
				read = true
				return undefined
			},
		}
		await expect(assertV1Hub(node, HUB, legacy)).rejects.toThrow(/no claim_from_pool/)
		expect(read).toBe(false)
	})
})
