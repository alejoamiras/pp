/**
 * Root overrides that lift a vulnerable package past the exact version its parent pins. Each holds only
 * while the parent still pins a version below the fix; once it pins the fix or declares anything else,
 * this test fails and the override is deleted or re-checked.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")

type Advisory = { child: string; fixed: string }

/** parent → the child it pins exactly, and the first version that clears every high advisory on it. */
const ADVISORY_OVERRIDES: Record<string, Advisory> = {
	// GHSA-wphj-fx3q-84ch and five more, the last fixed in 5.33.16; under @aztec-labs/telemetry-client.
	"@opentelemetry/host-metrics": { child: "systeminformation", fixed: "5.33.16" },
	// GHSA-qpx9-hpmf-5gmw; under snarkjs's bfj.
	jsonpath: { child: "underscore", fixed: "1.13.8" },
}

type Entry = [string, string?, { dependencies?: Record<string, string> }?, string?]
type Lock = { packages: Record<string, Entry> }
type Root = { overrides?: Record<string, unknown> }

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** The name in a resolved `name@version` id. */
const idName = (id: string) => id.slice(0, id.lastIndexOf("@"))

/** Every override key path, at any depth, whose key mentions `child`. */
function pathsNaming(rules: Record<string, unknown>, child: string, at: string[] = []): string[][] {
	const found: string[][] = []
	for (const [key, rule] of Object.entries(rules)) {
		const path = [...at, key]
		if (key.includes(child)) found.push(path)
		if (typeof rule === "object" && rule !== null) found.push(...pathsNaming(rule as Record<string, unknown>, child, path))
	}
	return found
}

/** The package names a lock key nests through, outermost first: `a/@s/b` → `a`, `@s/b`. */
function keyNames(key: string): string[] {
	const names: string[] = []
	for (const part of key.split("/")) {
		const last = names.at(-1)
		if (last?.startsWith("@") && !last.includes("/")) names[names.length - 1] = `${last}/${part}`
		else names.push(part)
	}
	return names
}

/** What the package at `key` gets for `child`: lock keys are node_modules paths, so nested first, then each ancestor. */
function resolveFrom(lock: Lock, key: string, child: string): string | undefined {
	const names = keyNames(key)
	for (let depth = names.length; depth >= 0; depth--) {
		const at = [...names.slice(0, depth), child].join("/")
		if (Object.hasOwn(lock.packages, at)) return lock.packages[at][0]
	}
	return undefined
}

/** Why the parent's own spec no longer needs the override, or an empty list. */
function pinProblems(parent: string, child: string, fixed: string, declared: string | undefined): string[] {
	if (declared === undefined) return [`${parent} no longer depends on ${child}: delete the override`]
	if (!EXACT.test(declared))
		return [
			`${parent} declares ${child} "${declared}", not an exact pin: delete the override if that admits ${fixed}, else re-check it`,
		]
	if (Bun.semver.order(declared, fixed) >= 0) return [`${parent} now pins ${child} ${declared}, at or past ${fixed}: delete the override`]
	return []
}

/** Why one advisory override is wrong, or an empty list. */
function overrideProblems(root: Root, lock: Lock, parent: string, { child, fixed }: Advisory): string[] {
	const problems: string[] = []
	const paths = pathsNaming(root.overrides ?? {}, child).map((path) => path.join(" > "))
	if (paths.join() !== `${parent} > ${child}`)
		problems.push(`overrides naming ${child}: ${paths.join(", ") || "none"}; want only ${parent} > ${child}`)
	const rule = root.overrides?.[parent]
	const value = typeof rule === "object" && rule !== null ? (rule as Record<string, unknown>)[child] : undefined
	if (typeof value !== "string" || !EXACT.test(value) || Bun.semver.order(value, fixed) < 0) {
		problems.push(`${parent}: no exact { "${child}": "<version>" } override at or past ${fixed}`)
		return problems
	}
	const parents = Object.entries(lock.packages).filter(([, [id]]) => idName(id) === parent)
	if (parents.length !== 1) {
		problems.push(`${parent}: ${parents.length} copies in the lock, not one`)
		return problems
	}
	const [key, [, , meta]] = parents[0]
	problems.push(...pinProblems(parent, child, fixed, meta?.dependencies?.[child]))
	const got = resolveFrom(lock, key, child)
	if (got !== `${child}@${value}`) problems.push(`${parent} resolves ${child} to ${got ?? "nothing"}, not ${child}@${value}`)
	const copies = Object.values(lock.packages)
		.map(([id]) => id)
		.filter((id) => idName(id) === child)
	if (copies.join() !== `${child}@${value}`) problems.push(`${child}: the lock resolves ${copies.join(", ")}, not only ${value}`)
	return problems
}

function advisoryProblems(root: Root, lock: Lock, table: Record<string, Advisory>): string[] {
	return Object.entries(table).flatMap(([parent, advisory]) => overrideProblems(root, lock, parent, advisory))
}

test("each advisory override meets its fix, is the only rule naming its child, and is what the parent resolves", () => {
	const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Root
	const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as Lock
	expect(advisoryProblems(root, lock, ADVISORY_OVERRIDES)).toEqual([])
})

test("the advisory override check fails closed on each way an override stops holding", () => {
	const table = { parent: { child: "child", fixed: "1.0.2" } }
	const held: Root = { overrides: { parent: { child: "1.0.2" } } }
	const entry = (id: string, deps?: Record<string, string>): Entry => [id, "", deps ? { dependencies: deps } : {}, ""]
	const lock = (declared: string, extra: Record<string, string> = {}, parentKey = "parent"): Lock => ({
		packages: {
			[parentKey]: entry("parent@1.0.0", { child: declared }),
			child: entry("child@1.0.2"),
			...Object.fromEntries(Object.entries(extra).map(([key, id]) => [key, entry(id)])),
		},
	})
	const noRule = 'parent: no exact { "child": "<version>" } override at or past 1.0.2'
	const cases: [Root, Lock, string[]][] = [
		[held, lock("1.0.0"), []],
		[held, lock("1.0.0", {}, "@s/a/parent"), []],
		[{ overrides: {} }, lock("1.0.0"), ["overrides naming child: none; want only parent > child", noRule]],
		[{ overrides: { parent: { child: "1.0.1" } } }, lock("1.0.0", { child: "child@1.0.1" }), [noRule]],
		[{ overrides: { parent: { child: "01.0.2" } } }, lock("1.0.0"), [noRule]],
		[held, lock("1.0.2"), ["parent now pins child 1.0.2, at or past 1.0.2: delete the override"]],
		[
			held,
			lock("npm:child@1.0.0"),
			['parent declares child "npm:child@1.0.0", not an exact pin: delete the override if that admits 1.0.2, else re-check it'],
		],
		[held, { packages: { child: entry("child@1.0.2") } }, ["parent: 0 copies in the lock, not one"]],
		[held, lock("1.0.0", { "parent/child": "@evil/child@9.0.0" }), ["parent resolves child to @evil/child@9.0.0, not child@1.0.2"]],
		[
			{ overrides: { parent: { child: "1.0.2" }, "parent@1.0.0": { child: "npm:@evil/child@9.0.0" } } },
			lock("1.0.0"),
			["overrides naming child: parent > child, parent@1.0.0 > child; want only parent > child"],
		],
		[held, lock("1.0.0", { "other/child": "child@1.0.0" }), ["child: the lock resolves child@1.0.2, child@1.0.0, not only 1.0.2"]],
	]
	for (const [root, lockfile, want] of cases) expect(advisoryProblems(root, lockfile, table)).toEqual(want)
})
