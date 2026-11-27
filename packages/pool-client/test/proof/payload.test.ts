import { join } from "node:path"
import { type Address, hashTypedData, type TypedDataDefinition } from "viem"
import { expect, it } from "vitest"
import { checkout } from "../../../pp-env/src/env/checkout.ts"
import { secretDerivationTypedData } from "../../src/keys.ts"

const ADDRESS: Address = "0x71bE63f3384f5fb98995898A86B02Fb2426c5788"

it("signs the same digest as the checked-out sample app's own builder, with the checkout's own APP_IDENTIFIER", async () => {
	const sample = (await import(join(checkout().src, "apps/sample-web/src/secretDerivationPayload.ts"))) as {
		buildSecretDerivationPayload(a: Address): TypedDataDefinition
	}
	const theirs = sample.buildSecretDerivationPayload(ADDRESS)
	expect(hashTypedData(secretDerivationTypedData(ADDRESS))).toBe(hashTypedData(theirs))
	expect(Object.keys(theirs.domain ?? {}).sort()).toEqual(["name", "salt", "verifyingContract", "version"])
})
