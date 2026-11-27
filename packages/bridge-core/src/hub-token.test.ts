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
const TOKEN_CLASS_ID = "0x04999e44146bf207240c03ba11b7ea3dbaac99aad3fa35c21fafd90e47b00f6c"
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
		["no registry", AztecAddress.ZERO, "0x0eb98022ce121743822703080b043606102eb13412f2add3872994e5230539e2"],
		["a registry", REGISTRY, "0x1e9b63585361e5e7ae746b001924f40b2b7f27e11e718da0c46bf6ceed0ae137"],
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
