import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { checkout } from "../../src/env/checkout.ts"
import { CONTRACTS_DIR } from "../../src/env/pins.ts"

// A Forge input missing from the manifest could drift unverified and make a deploy recompile into
// the shared `out`; dependencies and verifiers live outside the contracts' own `src`.
test("the fetched tree's manifest covers every source Forge compiled", () => {
	const co = checkout()
	const manifest = JSON.parse(readFileSync(join(co.target, "manifest.json"), "utf8")) as Record<string, string>
	const cache = JSON.parse(readFileSync(join(co.contracts, "cache/solidity-files-cache.json"), "utf8")) as { files: object }
	const inputs = Object.keys(cache.files).map((f) => join(CONTRACTS_DIR, f))
	expect(inputs.filter((p) => p.includes("node_modules") || !p.startsWith(CONTRACTS_DIR)).length).toBeGreaterThan(50)
	expect(inputs.filter((p) => !(p in manifest))).toEqual([])
})
