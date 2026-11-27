import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { checkout } from "../../../pp-env/src/env/checkout.ts"
import {
	ASP_REGISTRY_VIEWS_ABI,
	KEYSTORE_VIEWS_ABI,
	POOL_VAULT_ERRORS_ABI,
	POOL_VAULT_EVENTS_ABI,
	POOL_VAULT_VIEWS_ABI,
} from "../../src/abi.ts"

type AbiItem = { type: string; name?: string }

/** Drops what viem ignores: Solidity internal types and the default `anonymous: false`. */
const bare = (v: unknown): unknown =>
	Array.isArray(v)
		? v.map(bare)
		: v && typeof v === "object"
			? Object.fromEntries(
					Object.entries(v).flatMap(([k, x]) =>
						k === "internalType" || (k === "anonymous" && x === false) ? [] : [[k, bare(x)]],
					),
				)
			: v

const compiled = (contract: string): AbiItem[] =>
	(JSON.parse(readFileSync(join(checkout().contracts, `out/${contract}.sol/${contract}.json`), "utf8")) as { abi: AbiItem[] }).abi

it.each([
	["PoolVault", [...POOL_VAULT_ERRORS_ABI, ...POOL_VAULT_EVENTS_ABI, ...POOL_VAULT_VIEWS_ABI]],
	["Keystore", KEYSTORE_VIEWS_ABI],
	["ASPRegistry", ASP_REGISTRY_VIEWS_ABI],
] as const)("our %s items equal the compiled contract's", (contract, ours) => {
	const abi = compiled(contract)
	for (const item of ours) expect(bare(abi.find((i) => i.type === item.type && i.name === item.name))).toEqual(bare(item))
})

it("lists every PoolVault error, so no vault revert decodes as unknown", () => {
	const names = (abi: readonly AbiItem[]) =>
		abi
			.filter((i) => i.type === "error" && i.name?.startsWith("PoolVault_"))
			.map((i) => i.name)
			.sort()
	expect(names(POOL_VAULT_ERRORS_ABI)).toEqual(names(compiled("PoolVault")))
})
