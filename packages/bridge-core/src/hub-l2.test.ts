import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import { describe, expect, it } from "vitest"
import { hubBindingAt, hubTokenOfSlot } from "./hub-l2"

const ERC20 = "0x00000000000000000000000000000000000e2c20"
const L2_TOKEN = `0x${"11".repeat(32)}`

describe("hub binding from public storage", () => {
	const HUB = `0x00${"33".repeat(31)}`

	function fakeNode(answer: Fr) {
		const reads: Array<[string, string]> = []
		return {
			reads,
			getPublicStorageAt: async (_block: "latest", contract: { toString(): string }, slot: Fr) => {
				reads.push([contract.toString(), slot.toString()])
				return answer
			},
		}
	}

	it("reads the token_of entry at the slot the map derives for the ERC-20, on the hub", async () => {
		const node = fakeNode(Fr.fromString(L2_TOKEN))
		expect(await hubBindingAt(node, HUB, ERC20)).toBe(L2_TOKEN)
		const expected = (await deriveStorageSlotInMap(hubTokenOfSlot(), EthAddress.fromString(ERC20))).toString()
		expect(node.reads).toEqual([[AztecAddress.fromStringUnsafe(HUB).toString(), expected]])
	})

	it("an unwritten slot reads as zero, which is no binding", async () => {
		expect(await hubBindingAt(fakeNode(Fr.ZERO), HUB, ERC20)).toBeUndefined()
	})
})
