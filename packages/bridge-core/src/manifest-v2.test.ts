import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { deriveHubTokenInstance } from "./hub-token"
import { assertManifestTokensDerive, deriveManifestHub, manifestToken, parseManifestV2, parseManifestV2Strict } from "./manifest-v2"
import { predictPortal } from "./portal-address"

const TOKEN_CLASS_ID = "0x1e897c194970e0f495ca5e73956992f131fc38243e3f5b74812a99b9e86d397f"
const FACTORY = "0x3333333333333333333333333333333333333333"
const IMPL = "0x1111111111111111111111111111111111111111"
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const ASP_REGISTRY = "0x0000000000000000000000000000000000000000000000000000000000000ab1"
const NAME_WORD = "0x005465737420546f6b656e000000000000000000000000000000000000000000"
const SYMBOL_WORD = "0x0054535400000000000000000000000000000000000000000000000000000000"
const HUB_RECORD = {
	salt: `0x${"0".repeat(24)}${FACTORY.slice(2)}`,
	constructorArtifact: "constructor",
	constructorArgs: [TOKEN_CLASS_ID, FACTORY, ASP_REGISTRY],
}
const HUB = (
	await deriveManifestHub({ l2: { hub: { ...HUB_RECORD, address: "" } } } as unknown as Parameters<typeof deriveManifestHub>[0])
).address.toString()

async function fixture() {
	const inst = await deriveHubTokenInstance(
		AztecAddress.fromStringUnsafe(HUB),
		ERC20,
		{ nameWord: NAME_WORD, symbolWord: SYMBOL_WORD, decimals: 18 },
		TOKEN_CLASS_ID,
		AztecAddress.fromStringUnsafe(ASP_REGISTRY),
	)
	return {
		schema: 2,
		network: "sandbox",
		l1ChainId: 31337,
		walletChainId: 31337,
		bridge: {
			l1: {
				registry: "0x0000000000000000000000000000000000000001",
				factory: FACTORY,
				implementation: IMPL,
				guardian: "0x0000000000000000000000000000000000000002",
			},
			l2: {
				hub: { ...HUB_RECORD, address: HUB },
				aspRegistry: ASP_REGISTRY,
				tokenClassId: TOKEN_CLASS_ID,
				tokenArtifactSha256: "a".repeat(64),
			},
			tokens: [
				{
					erc20: ERC20,
					portal: predictPortal(FACTORY, IMPL, ERC20),
					l2Token: inst.address.toString(),
					nameWord: NAME_WORD,
					symbolWord: SYMBOL_WORD,
					decimals: 18,
					displayName: "Test Token",
					displaySymbol: "TST",
					source: "permissionless-mint",
					sourceContract: "TestUsdc",
					maxWholePerTx: 1000,
				},
			],
		},
		privateClaimMode: "salt-v2",
	}
}

describe("manifest v2 (strict, self-deriving)", () => {
	it("accepts a coherent manifest and derives every token", async () => {
		const m = await parseManifestV2Strict(await fixture())
		expect(m.bridge?.tokens[0].displaySymbol).toBe("TST")
		expect(manifestToken(m, ERC20.toUpperCase())?.erc20).toBe(ERC20)
		expect(manifestToken(m, "0x0000000000000000000000000000000000000009")).toBeUndefined()
	})

	it("accepts bridge: null (the placeholder network)", async () => {
		const m = parseManifestV2({ ...(await fixture()), bridge: null })
		expect(m.bridge).toBeNull()
		await expect(assertManifestTokensDerive(m)).resolves.toBeUndefined()
	})

	it("rejects a portal that is not the factory's CREATE2 for the token", async () => {
		const raw = await fixture()
		raw.bridge.tokens[0].portal = "0x00000000000000000000000000000000000000ee"
		expect(() => parseManifestV2(raw)).toThrow(/tokens\.0\.portal: portal is not the factory's CREATE2/)
	})

	it("rejects an l2Token the hub would not derive", async () => {
		const raw = await fixture()
		raw.bridge.tokens[0].l2Token = `0x${"1".repeat(64)}`
		await expect(parseManifestV2Strict(raw)).rejects.toThrow(/is not the hub's derivation/)
	})

	it("rejects a hub address that is not the instantiation of its own record, and a salt that is not the factory", async () => {
		const carried = await fixture()
		carried.bridge.l2.hub.address = `0x${"2".repeat(64)}`
		await expect(parseManifestV2Strict(carried)).rejects.toThrow(/not the instantiation of its own record/)
		const foreignSalt = await fixture()
		foreignSalt.bridge.l2.hub.salt = `0x${"3".repeat(64)}`
		expect(() => parseManifestV2(foreignSalt)).toThrow(/hub salt must be the factory/)
	})

	it("rejects hub constructor args that disagree with the manifest", async () => {
		const raw = await fixture()
		raw.bridge.l2.hub.constructorArgs = [TOKEN_CLASS_ID, "0x0000000000000000000000000000000000000009", ASP_REGISTRY]
		expect(() => parseManifestV2(raw)).toThrow(/hub constructorArgs must be \[tokenClassId, factory, aspRegistry\]/)
	})

	it("rejects duplicate tokens and unknown keys", async () => {
		const dup = await fixture()
		dup.bridge.tokens.push({ ...dup.bridge.tokens[0], erc20: ERC20.toUpperCase().replace("0X", "0x") })
		expect(() => parseManifestV2(dup)).toThrow(/duplicate token/)

		const unknown = await fixture()
		;(unknown as { extra?: unknown }).extra = 1
		expect(() => parseManifestV2(unknown)).toThrow(/Unrecognized key/)
	})
})
