/**
 * The Aztec line declares zod at a range that excludes GHSA-mrhx-c7xc-m3w5's fix, so the root overrides
 * zod, under exactly the `@aztec-labs/*` packages that declare it, to the catalog's version: one patched
 * zod under the SDK, and one viem peer variant beside it. The override goes at the bump whose Aztec
 * ranges all admit the catalog's zod.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Catalogs, resolveSpec } from "../catalog"

const ROOT = join(import.meta.dir, "..", "..")

type Specs = Record<string, string>
type Meta = { dependencies?: Specs; optionalDependencies?: Specs; peerDependencies?: Specs }
type Lock = { packages: Record<string, [string, string?, Meta?, string?]> }
type Root = Catalogs & { overrides?: Record<string, unknown> }

/**
 * The zod override each package gets: `{ "<package>": { "zod": "<spec>" } }`. Any other override that
 * names zod (global, `a>zod`, `zod@<range>`, deeper nesting) is returned as a stray.
 */
function zodOverrides(overrides: Record<string, unknown>): { scoped: Map<string, string>; strays: string[] } {
	const scoped = new Map<string, string>()
	const strays: string[] = []
	const names = (s: string) => /(^|[>/])zod($|@)/.test(s)
	const nested = (key: string, inner: string, spec: unknown) => {
		if (inner === "zod" && typeof spec === "string") scoped.set(key, spec)
		else if (names(inner) || JSON.stringify(spec).includes("zod")) strays.push(`${key} > ${inner}`)
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (names(key)) strays.push(key)
		if (typeof value === "object" && value !== null) for (const [inner, spec] of Object.entries(value)) nested(key, inner, spec)
	}
	return { scoped, strays }
}

/** The zod range each `@aztec-labs/*` package in the lock declares, by package name. */
function aztecZodRanges(lock: Lock): Map<string, string> {
	const ranges = new Map<string, string>()
	for (const [id, , meta] of Object.values(lock.packages)) {
		const name = /^(@aztec-labs\/[^@]+)@/.exec(id)?.[1]
		const range = meta?.dependencies?.zod ?? meta?.optionalDependencies?.zod ?? meta?.peerDependencies?.zod
		if (name && range !== undefined) ranges.set(name, range)
	}
	return ranges
}

/** Why the zod override is wrong, or an empty list. */
function zodOverrideProblems(root: Root, lock: Lock): string[] {
	const catalog = resolveSpec("zod", "catalog:", root)
	const { scoped, strays } = zodOverrides(root.overrides ?? {})
	const ranges = aztecZodRanges(lock)
	const problems = strays.map((s) => `override ${s}: only { "<@aztec-labs package>": { "zod": ... } } is held`)
	for (const [name, spec] of scoped) {
		if (!ranges.has(name)) problems.push(`${name}: overridden, but it declares no zod`)
		const value = resolveSpec("zod", spec, root)
		if (value !== catalog) problems.push(`${name}: overrides zod to ${value}, the catalog holds ${catalog}`)
	}
	for (const name of ranges.keys()) if (!scoped.has(name)) problems.push(`${name}: declares zod ${ranges.get(name)}, not overridden`)
	if (ranges.size > 0 && [...ranges.values()].every((r) => Bun.semver.satisfies(catalog, r)))
		problems.push(`every Aztec zod range admits ${catalog}: delete the zod overrides`)
	return problems
}

test("each Aztec package that declares zod is overridden to the catalog's zod, while any of them needs it", () => {
	const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Root
	const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as Lock
	expect(zodOverrideProblems(root, lock)).toEqual([])
})

test("the zod override check refuses a gap, a stale entry, a drifted value, a stray form, and a needless override", () => {
	const lock = (ranges: Record<string, string>): Lock => ({
		packages: Object.fromEntries([
			...Object.entries(ranges).map(([name, range]) => [name, [`${name}@6.0.0`, "", { dependencies: { zod: range } }, ""]]),
			["@aztec-labs/constants", ["@aztec-labs/constants@6.0.0", "", {}, ""]],
			["@nulo-sh/schema-patch", ["@nulo-sh/schema-patch@0.3.0", "", { dependencies: { zod: "^4.4.3" } }, ""]],
		]),
	})
	const two = lock({ "@aztec-labs/stdlib": "~4.4.3", "@aztec-labs/foundation": "~4.4.3" })
	const root = (overrides: Record<string, unknown>): Root => ({ catalog: { zod: "4.6.7" }, overrides })
	const both = { "@aztec-labs/stdlib": { zod: "4.6.7" }, "@aztec-labs/foundation": { zod: "catalog:" } }
	expect(zodOverrideProblems(root(both), two)).toEqual([])
	expect(zodOverrideProblems(root({ "@aztec-labs/stdlib": { zod: "4.6.7" } }), two)).toEqual([
		"@aztec-labs/foundation: declares zod ~4.4.3, not overridden",
	])
	expect(zodOverrideProblems(root({ ...both, "@aztec-labs/constants": { zod: "4.6.7" } }), two)).toEqual([
		"@aztec-labs/constants: overridden, but it declares no zod",
	])
	expect(zodOverrideProblems(root({ ...both, "@aztec-labs/stdlib": { zod: "4.6.8" } }), two)).toEqual([
		"@aztec-labs/stdlib: overrides zod to 4.6.8, the catalog holds 4.6.7",
	])
	for (const stray of [
		{ zod: "4.6.7" },
		{ "@aztec-labs/stdlib>zod": "4.6.7" },
		{ "zod@~4.4.3": "4.6.7" },
		{ x: { y: { zod: "4.6.7" } } },
	])
		expect(zodOverrideProblems(root({ ...both, ...stray }), two), JSON.stringify(stray)).toHaveLength(1)
	expect(zodOverrideProblems(root(both), lock({ "@aztec-labs/stdlib": "^4.6.6", "@aztec-labs/foundation": "~4.6.7" }))).toEqual([
		"every Aztec zod range admits 4.6.7: delete the zod overrides",
	])
})
