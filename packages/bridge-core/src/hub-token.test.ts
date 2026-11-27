/**
 * KEYSTONE (TS leg): the hub-derived token instance must equal the hub's in-circuit `derive_token`
 * (contracts/bridge/aztec/token_bridge_hub/src/test/keystone.nr) for the fixed vectors. The class id
 * is the committed LabelledToken's — the same pin as noir-artifact-classids.test.ts. The vectors are
 * the token's `bench/handoff.json` cases.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { deriveHubTokenInstance, hubTokenSalt } from "./hub-token"

const HUB = AztecAddress.fromBigIntUnsafe(0x1234000000000000000000000000000000000000000000000000000000000abcn)
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const TOKEN_CLASS_ID = "0x1e897c194970e0f495ca5e73956992f131fc38243e3f5b74812a99b9e86d397f"
const WORDS = {
	nameWord: "0x005465737420546f6b656e000000000000000000000000000000000000000000",
	symbolWord: "0x0054535400000000000000000000000000000000000000000000000000000000",
	decimals: 18,
}
const REGISTRY = AztecAddress.fromBigIntUnsafe(0x7e57n)

describe("hub token keystone", () => {
	it("salts with the ERC-20 address", () => {
		expect(hubTokenSalt(ERC20).toString()).toBe("0x00000000000000000000000000000000000000000000000000000000000e2c20")
	})

	it.each([
		["no registry", AztecAddress.ZERO, "0x1287035af71b0e9d6dd572a6a644d9dc81478fd1730de36f88d60b10f8fe5aa8"],
		["a registry", REGISTRY, "0x04e2b6fc9ed4689e489d37406106230604634d586af92584a70cd3e0c77deaa6"],
	])("matches the hub's in-circuit derivation with %s", async (_, registry, address) => {
		const inst = await deriveHubTokenInstance(HUB, ERC20, WORDS, TOKEN_CLASS_ID, registry)
		expect(inst.currentContractClassId.toString()).toBe(TOKEN_CLASS_ID)
		expect(inst.deployer.equals(HUB)).toBe(true)
		expect(inst.address.toString()).toBe(address)
	})

	it("refuses a hub whose token class is not the committed one", async () => {
		await expect(deriveHubTokenInstance(HUB, ERC20, WORDS, `0x${"1".repeat(64)}`, AztecAddress.ZERO)).rejects.toThrow(
			"hub token class mismatch",
		)
	})
})
