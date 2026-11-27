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
const TOKEN_CLASS_ID = "0x24c218f6ead283941970e94ece49a54679425f150ec5b44741dedebfb4f53d2f"
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
		["no registry", AztecAddress.ZERO, "0x18c02538f592b6187ff8aed1275cef92497b816ec09b5b96045a39ce09583a06"],
		["a registry", REGISTRY, "0x1fecd4814e9ad07d78f61c6a85739628ad7f4ab5b06ff54c57e05e12fa3061b4"],
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
