#!/usr/bin/env bun
// Each hand-written public entry exports exactly the names its implementation does. conformance.ts
// compares the values' types; `keyof typeof` cannot see type-only exports, so the names, types
// included, are compared here. A whole-program tsc run (~1,400 files, mostly viem's types), so it
// sits in the typecheck layer rather than beside every workspace's unit tests.
import { join } from "node:path"
import ts from "typescript"
import { PACKAGE_DIR } from "../src/env/checkout.ts"

/** Implementation entry, then the hand-written public entry that must export the same names. */
const ENTRIES = [
	["src/index.ts", "types/index.d.ts"],
	["src/client/index.ts", "types/client.d.ts"],
	["src/env/fork.ts", "types/fork.d.ts"],
] as const

const program = ts.createProgram(
	ENTRIES.flat().map((f) => join(PACKAGE_DIR, f)),
	{
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		noEmit: true,
		types: [],
	},
)
const checker = program.getTypeChecker()

function names(file: string): string[] {
	const source = program.getSourceFile(join(PACKAGE_DIR, file))
	const module = source && checker.getSymbolAtLocation(source)
	if (!module) throw new Error(`${file} is not a module`)
	return checker
		.getExportsOfModule(module)
		.map((s) => s.name)
		.sort()
}

let failed = false
for (const [impl, pub] of ENTRIES) {
	const want = new Set(names(impl))
	const have = new Set(names(pub))
	const missing = [...want].filter((n) => !have.has(n))
	const extra = [...have].filter((n) => !want.has(n))
	if (missing.length === 0 && extra.length === 0) continue
	failed = true
	console.error(`${pub} does not match ${impl}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`)
}
if (failed) process.exit(1)
console.log(`public entries export what their implementations do (${ENTRIES.length} pairs)`)
