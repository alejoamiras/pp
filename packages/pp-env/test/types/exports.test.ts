import { expect, test } from "bun:test"
import { join } from "node:path"
import ts from "typescript"

const ROOT = join(import.meta.dir, "../..")
/** Implementation entry, then the hand-written public entry that must export the same names. */
const ENTRIES = [
	["src/index.ts", "types/index.d.ts"],
	["src/client/index.ts", "types/client.d.ts"],
] as const

// conformance.ts compares the values' types; `keyof typeof` cannot see type-only exports, so the
// names, types included, are compared here.
// A whole-program tsc run (~1,400 files, mostly viem's types): 2–4 s alone, CPU-bound, beside
// every workspace's tests in test:all.
test("each public entry exports exactly the names its implementation does", () => {
	const program = ts.createProgram(
		ENTRIES.flat().map((f) => join(ROOT, f)),
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
	const names = (file: string) => {
		const source = program.getSourceFile(join(ROOT, file))
		const module = source && checker.getSymbolAtLocation(source)
		if (!module) throw new Error(`${file} is not a module`)
		return checker
			.getExportsOfModule(module)
			.map((s) => s.name)
			.sort()
	}
	for (const [impl, pub] of ENTRIES) expect(names(pub)).toEqual(names(impl))
}, 20_000)
