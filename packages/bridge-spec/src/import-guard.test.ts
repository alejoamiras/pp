import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * The root entry is the browser-safe surface: `@aztec-labs/*` initialises Barretenberg on import.
 * Walks the static runtime graph from `src/index.ts`; only clause-level `import type` / `export type`
 * is erased, since `import { type X }` can survive as a side-effect import.
 */
function runtimeGraph(entry: string): { files: Set<string>; bare: Set<string>; lazy: Set<string> } {
	const files = new Set<string>()
	const bare = new Set<string>()
	const lazy = new Set<string>()
	const visit = (file: string) => {
		if (files.has(file)) return
		files.add(file)
		const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
		const follow = (spec: string) => (spec.startsWith(".") ? visit(resolve(dirname(file), `${spec}.ts`)) : bare.add(spec))
		const walk = (node: ts.Node) => {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const [arg] = node.arguments
				if (arg && ts.isStringLiteral(arg)) lazy.add(arg.text)
			}
			ts.forEachChild(node, walk)
		}
		for (const stmt of src.statements) {
			if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) follow((stmt.moduleSpecifier as ts.StringLiteral).text)
			if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && !stmt.isTypeOnly)
				follow((stmt.moduleSpecifier as ts.StringLiteral).text)
		}
		walk(src)
	}
	visit(entry)
	return { files, bare, lazy }
}

describe("root entry import guard", () => {
	const src = resolve(__dirname)
	const graph = runtimeGraph(resolve(src, "index.ts"))

	it("loads no @aztec-labs module statically", () => {
		expect(graph.bare).toContain("poseidon-lite")
		expect([...graph.bare].filter((m) => m.startsWith("@aztec-labs/"))).toEqual([])
	})

	it("reaches the claim-secret mirror only through import(), and never the birth module", () => {
		expect(graph.files.has(resolve(src, "claim-secret.ts"))).toBe(false)
		expect(graph.files.has(resolve(src, "birth.ts"))).toBe(false)
		expect(graph.lazy.has("./claim-secret")).toBe(true)
	})
})
