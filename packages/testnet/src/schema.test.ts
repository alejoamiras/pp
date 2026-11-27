import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { expect, it } from "vitest"
import { parseDeployment } from "./schema"

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

it("refuses the zero address in an address field", () => {
	const network = {
		l1ChainId: 11155111,
		rollup: "0x1f435a7f2da358caf887a470faeee7d5d5f4efba",
		l1Registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
		inbox: "0x7cdc32dd7d008870a95f1837ffd7229ef676ef8a",
		outbox: "0xa5a0f7a7bdaf280964a1922a68c83462e5f6e15b",
		rollupVersion: 679261766,
		fpc: "0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3",
		l1Rpc: "https://sepolia.gateway.tenderly.co",
		aztecNode: "https://aztec-testnet.drpc.org",
		botPort: 48601,
	}
	const file = { network, target: "pool1", bundle: "ceremony" }
	expect(parseDeployment(file).network.rollup).toBe(network.rollup)
	const zero = { ...file, network: { ...network, rollup: `0x${"0".repeat(40)}` } }
	expect(() => parseDeployment(zero)).toThrow(/network\.rollup: the zero address/)
})
