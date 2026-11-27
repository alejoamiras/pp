/**
 * Root overrides that lift a vulnerable package past the exact version its parent pins. Each holds only
 * while the parent still declares a range that excludes the patched version; at the bump whose parent
 * admits it, this test fails and the override goes.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")

/** parent → the child it pins exactly; the override's value is the patched version. */
const ADVISORY_OVERRIDES: Record<string, string> = {
	// GHSA-wphj-fx3q-84ch and five more; under @aztec-labs/telemetry-client.
	"@opentelemetry/host-metrics": "systeminformation",
	// GHSA-qpx9-hpmf-5gmw; under snarkjs's bfj.
	jsonpath: "underscore",
}

type Meta = { dependencies?: Record<string, string> }
type Lock = { packages: Record<string, [string, string?, Meta?, string?]> }
type Root = { overrides?: Record<string, unknown> }

/** Why an advisory override is wrong, or an empty list. */
function advisoryProblems(root: Root, lock: Lock, table: Record<string, string>): string[] {
	const problems: string[] = []
	for (const [parent, child] of Object.entries(table)) {
		const rule = root.overrides?.[parent]
		const value = typeof rule === "object" && rule !== null ? (rule as Record<string, unknown>)[child] : undefined
		if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
			problems.push(`${parent}: no exact { "${child}": "<version>" } override`)
			continue
		}
		const declared = lock.packages[parent]?.[2]?.dependencies?.[child]
		if (declared === undefined) problems.push(`${parent}: not in the lock, or no longer depends on ${child}: delete the override`)
		else if (Bun.semver.satisfies(value, declared))
			problems.push(`${parent} now admits ${child} ${value} (${declared}): delete the override`)
		// By the resolved id, so every copy counts whatever its key, and `@scope/child` does not.
		const resolved = Object.values(lock.packages)
			.map(([id]) => id)
			.filter((id) => id.startsWith(`${child}@`))
		if (resolved.join() !== `${child}@${value}`)
			problems.push(`${child}: the lock resolves ${resolved.join(", ") || "nothing"}, not ${value}`)
	}
	return problems
}

test("each advisory override lifts a child its parent still pins below the fix, and the lock resolves only the fix", () => {
	const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Root
	const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as Lock
	expect(advisoryProblems(root, lock, ADVISORY_OVERRIDES)).toEqual([])
})

test("the advisory override check refuses a missing rule, a needless one, and a second copy", () => {
	const lock = (declared: string, copies: Record<string, string>): Lock => ({
		packages: {
			parent: ["parent@1.0.0", "", { dependencies: { child: declared } }, ""],
			...Object.fromEntries(Object.entries(copies).map(([key, v]) => [key, [`child@${v}`, "", {}, ""]])),
		},
	})
	const table = { parent: "child" }
	const held = { overrides: { parent: { child: "1.0.2" } } }
	expect(advisoryProblems(held, lock("1.0.0", { child: "1.0.2" }), table)).toEqual([])
	expect(advisoryProblems({ overrides: {} }, lock("1.0.0", { child: "1.0.2" }), table)).toEqual([
		'parent: no exact { "child": "<version>" } override',
	])
	expect(advisoryProblems(held, lock("^1.0.2", { child: "1.0.2" }), table)).toEqual([
		"parent now admits child 1.0.2 (^1.0.2): delete the override",
	])
	expect(advisoryProblems(held, lock("1.0.0", { child: "1.0.2", "other/child": "1.0.0" }), table)).toEqual([
		"child: the lock resolves child@1.0.2, child@1.0.0, not 1.0.2",
	])
})
