import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { expect, it } from "vitest"

const IMPORT =
	/^(?:import|export)\s+(?!type\b)(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+"([^"]+)"|^import\s+"([^"]+)"/gm

/** The bare modules `file` and every relative module it reaches import at run time; `import type` is erased. */
function runtimeImports(file: string, seen = new Set<string>()): string[] {
	if (seen.has(file)) return []
	seen.add(file)
	return [...readFileSync(file, "utf8").matchAll(IMPORT)].flatMap((m) => {
		const spec = (m[1] ?? m[2]) as string
		if (!spec.startsWith(".")) return [spec]
		return runtimeImports(resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`), seen)
	})
}

// `@pp/testnet/schema` is read by the app's build, so it must reach neither Node, Bun nor the key file.
it("the schema entry imports only zod at run time", () => {
	const walked = new Set<string>()
	expect(new Set(runtimeImports(resolve(__dirname, "schema.ts"), walked))).toEqual(new Set(["zod"]))
	expect(walked).toEqual(new Set(["schema.ts", "network.ts"].map((f) => resolve(__dirname, f))))
})
