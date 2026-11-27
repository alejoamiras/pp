/**
 * Fails when an artifact under `contracts/bridge/evm/out` records a machine path in its solc metadata:
 * this checkout's or the home directory anywhere in it, or any absolute source name, compilation
 * target, remapping context or remapping target. Solc hashes that metadata into every contract's
 * bytecode, and `PortalFactory` embeds `ProcessorPortalImpl`'s creation code, so one machine path makes
 * the bridge's bytecode differ per checkout. Run after `forge build`.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, posix, relative, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { EVM_ROOT } from "./gen-remappings"

/** Contracts whose artifacts must be present, with code, under their root-relative name, so the scan cannot pass vacuously. */
export const REQUIRED = ["PortalFactory", "ProcessorPortalImpl"]

type Metadata = { sources?: object; settings?: { compilationTarget?: Record<string, string>; remappings?: string[] } }
type Artifact = { rawMetadata?: unknown; ast?: { absolutePath?: string }; abi?: unknown[]; bytecode?: { object?: string } }

const isAbsolute = (p: string) => posix.isAbsolute(p) || win32.isAbsolute(p)

/** A remapping is `[context:]prefix=target`; a prefix never holds a colon. */
function remappingPaths(r: string): string[] {
	const head = r.slice(0, r.indexOf("="))
	return [head.slice(0, Math.max(head.lastIndexOf(":"), 0)), r.slice(r.indexOf("=") + 1)].filter((p) => p !== "")
}

function absoluteNames({ sources, settings }: Metadata): string[] {
	const remapped = (settings?.remappings ?? []).flatMap(remappingPaths)
	return [...Object.keys(sources ?? {}), ...Object.keys(settings?.compilationTarget ?? {}), ...remapped].filter(isAbsolute)
}

/** A file that defines no contract (`forge build --ast` writes one per such file): no metadata, no code, no ABI. */
const astOnly = (a: Artifact) => a.ast !== undefined && a.bytecode?.object === "0x" && a.abi?.length === 0

function inspect(file: string, artifact: Artifact, needles: readonly string[]): string[] {
	const raw = artifact.rawMetadata
	if (typeof raw !== "string") {
		if (!astOnly(artifact)) return [`${file}: no rawMetadata`]
		const name = artifact.ast?.absolutePath ?? ""
		return needles.some((n) => name.includes(n)) || isAbsolute(name) ? [`${file}: absolute source name ${name}`] : []
	}
	const problems = needles.filter((n) => raw.includes(n)).map((n) => `${file}: metadata contains ${n}`)
	const absolute = absoluteNames(JSON.parse(raw))
	if (absolute.length > 0) problems.push(`${file}: ${absolute.length} absolute path(s), first ${absolute[0]}`)
	return problems
}

function requiredProblems(out: string, files: readonly string[]): string[] {
	return REQUIRED.flatMap((name) => {
		const file = `${name}.sol/${name}.json`
		if (!files.includes(file)) return [`${file}: missing`]
		const artifact: Artifact = JSON.parse(readFileSync(join(out, file), "utf8"))
		const target =
			typeof artifact.rawMetadata === "string"
				? (JSON.parse(artifact.rawMetadata) as Metadata).settings?.compilationTarget
				: undefined
		const ok = target?.[`src/${name}.sol`] === name && (artifact.bytecode?.object?.length ?? 0) > 2
		return ok ? [] : [`${file}: not src/${name}.sol's compiled ${name}`]
	})
}

/**
 * Every problem with the contract artifacts under `out` (build-info excluded): a `REQUIRED` artifact
 * absent, without code or under another name; a `rawMetadata` missing (outside AST-only files),
 * containing a needle, or naming an absolute path. Empty means clean.
 */
export function metadataLeaks(out: string, needles: readonly string[]): string[] {
	const files = readdirSync(out, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json") && !f.startsWith("build-info"))
	const problems = requiredProblems(out, files)
	for (const file of files) problems.push(...inspect(file, JSON.parse(readFileSync(join(out, file), "utf8")), needles))
	return problems
}

/** The repository root and home directory, as given and resolved; a checkout reached by a link records either. */
export function checkoutNeedles(): string[] {
	const root = join(EVM_ROOT, "..", "..", "..")
	const paths = [root, homedir()].flatMap((p) => [p, realpathSync(p)])
	return [...new Set(paths)].filter((p) => p.length > 1)
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (isMain) {
	const out = join(EVM_ROOT, "out")
	const problems = metadataLeaks(out, checkoutNeedles())
	if (problems.length > 0) {
		console.error(`${problems.length} artifact problem(s) in ${relative(process.cwd(), out)}:`)
		for (const p of problems.slice(0, 20)) console.error(`  ${p}`)
		process.exit(1)
	}
	console.log("artifact metadata carries no machine path")
}
