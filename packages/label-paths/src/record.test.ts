import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import pkg from "../package.json"
import { type Hex, RegistryAddressError, ROOT_RECORD_SLOT, readRootRecord } from "./record"
import { MAX_LEAVES, MAX_OBSERVATION_LAG, MAX_ROOT_AGE, SPEND_WINDOW } from "./snapshot"

const REGISTRY_DIR = join(__dirname, "../../../contracts/bridge/aztec/asp_registry")
const REGISTRY = `0x${"0a".repeat(32)}` as Hex
const HASH = `0x${"bc".repeat(32)}`
const VALUES = [7n, 111n, 222n, 99n, 1_234n]

type Call = { method: string; params: unknown[] }

function fakeNode(reply: (c: Call) => unknown): Call[] {
	const calls: Call[] = []
	vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
		const c = JSON.parse(init.body) as Call
		calls.push(c)
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(reply(c) as object) }))
	})
	return calls
}

const node = (c: Call) => {
	if (c.method === "node_getBlockData") return { result: { blockHash: HASH } }
	const slot = BigInt(c.params[2] as string)
	return { result: `0x${(VALUES[Number(slot - ROOT_RECORD_SLOT)] as bigint).toString(16)}` }
}

afterEach(() => vi.unstubAllGlobals())

describe("readRootRecord", () => {
	it("reads the five fields in order at one block hash, and refuses bad input before any request", async () => {
		const calls = fakeNode(node)
		expect(await readRootRecord({ aztecNode: "http://node", registry: REGISTRY, at: 12 })).toEqual({
			sequence: 7n,
			poolRoot: 111n,
			birthRoot: 222n,
			l1Block: 99n,
			rootTime: 1_234n,
		})
		expect(calls[0]).toMatchObject({ method: "node_getBlockData", params: [12] })
		const reads = calls.slice(1)
		expect(reads.map((c) => c.params[0])).toEqual(Array(5).fill({ hash: HASH }))
		expect(reads.map((c) => BigInt(c.params[2] as string))).toEqual([0n, 1n, 2n, 3n, 4n].map((i) => ROOT_RECORD_SLOT + i))

		calls.length = 0
		for (const bad of [
			`0x${"0a".repeat(31)}0`,
			`0x${"0a".repeat(32)}0`,
			`0x${"0A".repeat(32)}`,
			`0x${"f".repeat(64)}`,
			"0a".repeat(32),
		]) {
			await expect(readRootRecord({ aztecNode: "http://node", registry: bad as Hex })).rejects.toBeInstanceOf(RegistryAddressError)
		}
		expect(calls).toEqual([])

		fakeNode((c) => (c.method === "node_getBlockData" ? node(c) : { error: { message: "pruned" } }))
		await expect(readRootRecord({ aztecNode: "http://node", registry: REGISTRY })).rejects.toThrow("node_getPublicStorageAt: pruned")
		fakeNode((c) => (c.method === "node_getBlockData" ? node(c) : { result: `0x1${"0".repeat(16)}` }))
		await expect(readRootRecord({ aztecNode: "http://node", registry: REGISTRY })).rejects.toThrow("sequence out of range")
	})

	it("is pinned to the registry's artifact slot and label_check constants", () => {
		const artifact = JSON.parse(readFileSync(join(REGISTRY_DIR, "target/asp_registry-AspRootRegistry.json"), "utf8"))
		const layout = artifact.outputs.globals.storage[0].value.fields[1].value.fields as {
			name: string
			value: { fields: { value: { value: string } }[] }
		}[]
		const current = layout.find((f) => f.name === "current")!
		expect(BigInt(`0x${current.value.fields[0]!.value.value}`)).toBe(ROOT_RECORD_SLOT)

		const nr = readFileSync(join(REGISTRY_DIR, "src/label_check.nr"), "utf8")
		const global = (name: string) => BigInt(nr.match(new RegExp(`pub global ${name}: u64 = (\\d+);`))![1]!)
		expect([MAX_OBSERVATION_LAG, MAX_ROOT_AGE, SPEND_WINDOW]).toEqual(
			["MAX_OBSERVATION_LAG", "MAX_ROOT_AGE", "SPEND_WINDOW"].map(global),
		)
		expect(MAX_LEAVES).toBe(2 ** 18)
	})
})

/** Every module specifier in `file`, `import type` included: TypeScript resolves it, so a consumer's typecheck needs the package. */
function specifiers(file: string): string[] {
	const out: string[] = []
	const visit = (n: ts.Node) => {
		if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
			out.push(n.moduleSpecifier.text)
		} else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const arg = n.arguments[0]
			out.push(arg && ts.isStringLiteral(arg) ? arg.text : "<non-literal import()>")
		}
		ts.forEachChild(n, visit)
	}
	visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest))
	return out
}

it("the package imports nothing but @pp/bridge-spec's root entry", () => {
	const sources = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	const bare = new Set(sources.flatMap((f) => specifiers(join(__dirname, f))).filter((s) => !s.startsWith("./")))
	expect([...bare]).toEqual(["@pp/bridge-spec"])
	expect(Object.keys(pkg.dependencies)).toEqual(["@pp/bridge-spec"])
})
