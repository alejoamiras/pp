import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as sdk from "@ppv2/evm-sdk"
import { POOL_VAULT_ERRORS_ABI, POOL_VAULT_EVENTS_ABI, POOL_VAULT_TRANSACT_ABI } from "../../src/client/abi.ts"
import { SECRET_DERIVATION_PURPOSE } from "../../src/client/derivation.ts"
import { checkout } from "../../src/env/checkout.ts"

type AbiItem = { type: string; name?: string; inputs?: readonly unknown[] }
/** Drops what viem ignores: Solidity internal types and the default `anonymous: false`. */
const stripInternalTypes = (v: unknown): unknown =>
	Array.isArray(v)
		? v.map(stripInternalTypes)
		: v && typeof v === "object"
			? Object.fromEntries(
					Object.entries(v).flatMap(([k, x]) =>
						k === "internalType" || (k === "anonymous" && x === false) ? [] : [[k, stripInternalTypes(x)]],
					),
				)
			: v

test("our PoolVault ABI matches the compiled contract, and covers all of its errors", () => {
	const artifact = join(checkout().contracts, "out/PoolVault.sol/PoolVault.json")
	const compiled = (JSON.parse(readFileSync(artifact, "utf8")) as { abi: AbiItem[] }).abi
	for (const ours of [...POOL_VAULT_TRANSACT_ABI, ...POOL_VAULT_ERRORS_ABI, ...POOL_VAULT_EVENTS_ABI]) {
		const theirs = compiled.find((i) => i.type === ours.type && i.name === ours.name)
		expect(stripInternalTypes(theirs)).toEqual(stripInternalTypes(ours))
	}
	const names = (items: readonly AbiItem[]) =>
		items
			.filter((i) => i.type === "error")
			.map((i) => i.name)
			.sort()
	expect(names(POOL_VAULT_ERRORS_ABI)).toEqual(names(compiled))
})

test("every SDK value the client uses is exported at runtime, not only in the typings", () => {
	const source = readFileSync(join(import.meta.dir, "../../src/client/pool.ts"), "utf8")
	const block = source.match(/import \{([^}]*)\} from "@ppv2\/evm-sdk"/)?.[1] ?? ""
	const values = block
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith("type "))
	expect(values.length).toBeGreaterThan(10)
	expect(values.filter((n) => !(n in sdk))).toEqual([])
	expect("APP_IDENTIFIER" in sdk).toBe(true)
})

test("the secret-derivation purpose matches the pinned upstream sample app byte for byte", () => {
	const upstream = readFileSync(join(checkout().src, "apps/sample-web/src/secretDerivationPayload.ts"), "utf8")
	expect(upstream).toContain(JSON.stringify(SECRET_DERIVATION_PURPOSE))
	expect(upstream).toContain('name: "Standardized Secret Derivation"')
})
