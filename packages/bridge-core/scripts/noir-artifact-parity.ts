/**
 * Compares a fresh build of a Noir crate with its committed artifact, which is what
 * `compile.sh --check` runs. Two things must match: what a deploy binds (a contract's class id, a
 * program's hash) and the ABI, which the class id does not cover: a renamed parameter or struct
 * field leaves it unchanged while every generated client changes. Byte identity is too strict
 * (debug metadata).
 *
 *   bun scripts/noir-artifact-parity.ts <contract|bin> <committed.json> <fresh.json>
 *
 * Exits 1 on drift, naming the binding or the first ABI field that differs.
 */
import { readFileSync } from "node:fs"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"

export type ArtifactKind = "contract" | "bin"
type Json = Record<string, unknown>

/** What a caller compiles against: names, types, visibility, attributes and storage, no bytecode. */
export function abiOf(kind: ArtifactKind, artifact: Json): unknown {
	if (kind === "bin") return artifact.abi
	const functions = (artifact.functions as Json[])
		.map(({ name, is_unconstrained, custom_attributes, abi }) => ({ name, is_unconstrained, custom_attributes, abi }))
		.sort((a, b) => String(a.name).localeCompare(String(b.name)))
	return { name: artifact.name, functions, outputs: artifact.outputs }
}

async function bindingOf(kind: ArtifactKind, artifact: Json): Promise<string> {
	if (kind === "bin") return String(artifact.hash)
	const cls = await getContractClassFromArtifact(loadContractArtifact(artifact as unknown as Parameters<typeof loadContractArtifact>[0]))
	return cls.id.toString()
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null

/** The path of the first value that differs between two JSON trees, or undefined when equal. */
export function firstDifference(a: unknown, b: unknown, path: string): string | undefined {
	if (!isObject(a) || !isObject(b)) return a === b ? undefined : path
	if (Array.isArray(a) !== Array.isArray(b)) return path
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
	for (const key of keys) {
		const diff = firstDifference(a[key], b[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`)
		if (diff) return diff
	}
	return undefined
}

/** Every drift between the committed and the fresh artifact; empty when they agree. */
export async function parityProblems(kind: ArtifactKind, committed: Json, fresh: Json): Promise<string[]> {
	const problems: string[] = []
	const [want, got] = await Promise.all([bindingOf(kind, committed), bindingOf(kind, fresh)])
	const binding = kind === "bin" ? "program hash" : "class id"
	if (want !== got) problems.push(`${binding} drift: committed ${want}, source compiles to ${got}`)
	const diff = firstDifference(abiOf(kind, committed), abiOf(kind, fresh), "abi")
	if (diff) problems.push(`ABI drift at ${diff}`)
	return problems
}

if (import.meta.main) {
	const [kind, committedPath, freshPath] = process.argv.slice(2)
	if ((kind !== "contract" && kind !== "bin") || !committedPath || !freshPath) {
		console.error("usage: bun scripts/noir-artifact-parity.ts <contract|bin> <committed.json> <fresh.json>")
		process.exit(2)
	}
	const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Json
	const problems = await parityProblems(kind, read(committedPath), read(freshPath))
	for (const p of problems) console.error(p)
	process.exit(problems.length ? 1 : 0)
}
