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

const NAME = /^(?:@[^@/\s>]+\/)?[^@/\s>]+$/

/**
 * The package a Bun override selector targets: the last of its `>`-separated parts, each trimmed and
 * either a name or `name@range`; undefined when any part is neither.
 */
function selectorTarget(selector: string): string | undefined {
	const names = selector.split(">").map((part) => /^((?:@[^@/\s>]+\/)?[^@/\s>]+)(?:@[^\s>/]+)?$/.exec(part.trim())?.[1])
	return names.every((n) => n !== undefined) ? names.at(-1) : undefined
}

/**
 * The zod override each package gets: `{ "<name>": { "zod": "<spec>" } }`, the parent a bare name.
 * Any other rule that targets zod at any depth (global, `a>zod`, `zod@<range>`, a `.` self-rule under
 * zod, deeper nesting, a padded key), and any selector that does not parse, is returned as a stray.
 */
function zodOverrides(overrides: Record<string, unknown>): { scoped: Map<string, string>; strays: string[] } {
	const scoped = new Map<string, string>()
	const strays: string[] = []
	// A `.` key is the object form's rule for its parent selector.
	const targetOf = (path: string[], key: string) => selectorTarget(key.trim() === "." ? (path.at(-1) ?? key) : key)
	const visit = (path: string[], key: string, value: unknown) => {
		const parent = path.length === 1 ? path[0] : undefined
		if (parent !== undefined && NAME.test(parent) && key === "zod" && typeof value === "string") scoped.set(parent, value)
		else if ([undefined, "zod"].includes(targetOf(path, key))) strays.push([...path, key].join(" > "))
		if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) visit([...path, key], k, v)
	}
	for (const [key, value] of Object.entries(overrides)) visit([], key, value)
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

/**
 * Why the zod overrides are wrong, or an empty list. While any Aztec zod range excludes the catalog's
 * version, every declaring package needs the scoped override at that version; once none does, there
 * must be no zod override at all.
 */
function zodOverrideProblems(root: Root, lock: Lock): string[] {
	const catalog = resolveSpec("zod", "catalog:", root)
	const { scoped, strays } = zodOverrides(root.overrides ?? {})
	const ranges = aztecZodRanges(lock)
	const problems = strays.map((s) => `override ${s}: only { "<@aztec-labs package>": { "zod": ... } } is held`)
	const needed = [...ranges.values()].some((r) => !Bun.semver.satisfies(catalog, r))
	if (!needed) return scoped.size > 0 ? [...problems, `every Aztec zod range admits ${catalog}: delete the zod overrides`] : problems
	for (const [name, spec] of scoped) {
		if (!ranges.has(name)) problems.push(`${name}: overridden, but it declares no zod`)
		const value = resolveSpec("zod", spec, root)
		if (value !== catalog) problems.push(`${name}: overrides zod to ${value}, the catalog holds ${catalog}`)
	}
	for (const [name, range] of ranges) if (!scoped.has(name)) problems.push(`${name}: declares zod ${range}, not overridden`)
	return problems
}

test("each Aztec package that declares zod is overridden to the catalog's zod, while any of them needs it", () => {
	const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Root
	const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as Lock
	expect(zodOverrideProblems(root, lock)).toEqual([])
})

test("the zod override check refuses a gap, a stale entry, a drifted value and a stray form", () => {
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
		{ "some-pkg> zod": "4.4.3" },
		{ "zod@~4.4.3": "4.6.7" },
		{ x: { y: { zod: "4.6.7" } } },
		{ "@aztec-labs/entrypoints": { " zod": "4.6.7" } },
		{ zod: { ".": "4.6.7" } },
		{ "a b": "1.0.0" },
	])
		expect(zodOverrideProblems(root({ ...both, ...stray }), two), JSON.stringify(stray)).not.toHaveLength(0)
	expect(zodOverrideProblems(root({ ...both, "@example/zod": "1.0.0", "zod-to-json-schema": { ".": "3.24.6" } }), two)).toEqual([])
})

test("once every Aztec zod range admits the catalog's zod, the overrides must go, and their absence passes", () => {
	const lock: Lock = {
		packages: {
			"@aztec-labs/stdlib": ["@aztec-labs/stdlib@7.0.0", "", { dependencies: { zod: "^4.6.6" } }, ""],
			"@aztec-labs/foundation": ["@aztec-labs/foundation@7.0.0", "", { peerDependencies: { zod: "~4.6.7" } }, ""],
		},
	}
	const root = (overrides: Record<string, unknown>): Root => ({ catalog: { zod: "4.6.7" }, overrides })
	expect(zodOverrideProblems(root({ "@aztec-labs/stdlib": { zod: "4.6.7" } }), lock)).toEqual([
		"every Aztec zod range admits 4.6.7: delete the zod overrides",
	])
	expect(zodOverrideProblems(root({ ws: "8.21.0" }), lock)).toEqual([])
	expect(zodOverrideProblems(root({}), { packages: {} })).toEqual([])
})
