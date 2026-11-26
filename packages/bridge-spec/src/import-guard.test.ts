import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * The root entry is the browser-safe surface: `@aztec-labs/*` initialises Barretenberg on import.
 * Walks the runtime graph from `src/index.ts`. Only clause-level `import type` / `export type` is
 * erased (`import { type X }` can survive as a side-effect import); `require()` counts as static, and
 * so does an `import()` outside a function body, which runs at load.
 */
type Graph = { files: Set<string>; bare: Set<string>; lazy: Set<string> }

const NON_LITERAL = "<non-literal module specifier>"

/** `import(…)` or `require(…)`, with its literal specifier when it has one. */
function moduleCall(node: ts.Node): { kind: "import" | "require"; spec?: string } | undefined {
	if (!ts.isCallExpression(node)) return undefined
	const kind =
		node.expression.kind === ts.SyntaxKind.ImportKeyword
			? "import"
			: ts.isIdentifier(node.expression) && node.expression.text === "require"
				? "require"
				: undefined
	if (kind === undefined) return undefined
	const [arg] = node.arguments
	return { kind, spec: arg && ts.isStringLiteral(arg) ? arg.text : undefined }
}

function staticSpecs(src: ts.SourceFile): string[] {
	return src.statements.flatMap((s) => {
		if (ts.isImportDeclaration(s) && !s.importClause?.isTypeOnly) return [(s.moduleSpecifier as ts.StringLiteral).text]
		if (ts.isExportDeclaration(s) && s.moduleSpecifier && !s.isTypeOnly) return [(s.moduleSpecifier as ts.StringLiteral).text]
		return []
	})
}

function visit(file: string, graph: Graph): void {
	if (graph.files.has(file)) return
	graph.files.add(file)
	const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
	const follow = (spec: string) => (spec.startsWith(".") ? visit(resolve(dirname(file), `${spec}.ts`), graph) : graph.bare.add(spec))
	const walk = (node: ts.Node, inFunction: boolean) => {
		const call = moduleCall(node)
		if (call?.spec === undefined && call !== undefined) graph.bare.add(NON_LITERAL)
		else if (call?.spec !== undefined) call.kind === "import" && inFunction ? graph.lazy.add(call.spec) : follow(call.spec)
		ts.forEachChild(node, (child) => walk(child, inFunction || ts.isFunctionLike(node)))
	}
	for (const spec of staticSpecs(src)) follow(spec)
	walk(src, false)
}

describe("root entry import guard", () => {
	const src = resolve(__dirname)
	const graph: Graph = { files: new Set(), bare: new Set(), lazy: new Set() }
	visit(resolve(src, "index.ts"), graph)

	it("loads no @aztec-labs module at load time", () => {
		expect(graph.bare).toContain("poseidon-lite")
		expect([...graph.bare].filter((m) => m.startsWith("@aztec-labs/") || m === NON_LITERAL)).toEqual([])
	})

	it("reaches the claim-secret mirror only through a deferred import(), and never the birth module", () => {
		expect(graph.files.has(resolve(src, "claim-secret.ts"))).toBe(false)
		expect(graph.files.has(resolve(src, "birth.ts"))).toBe(false)
		expect([...graph.lazy].sort()).toEqual(["./claim-secret", "@aztec-labs/foundation/curves/bn254"])
	})
})
