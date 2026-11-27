/**
 * Fails when an artifact under `contracts/bridge/evm/out` records a machine path in its solc metadata:
 * this checkout's or the home directory anywhere in it, or any absolute source name, compilation
 * target or remapping target. Solc hashes that metadata into every contract's bytecode, and
 * `PortalFactory` embeds `ProcessorPortalImpl`'s creation code, so one machine path makes the bridge's
 * bytecode differ per checkout. Run after `forge build`.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { EVM_ROOT } from "./gen-remappings"

/** Artifacts an empty or partial `out/` would lack, so the scan cannot pass having read nothing. */
export const REQUIRED = ["PortalFactory.sol/PortalFactory.json", "ProcessorPortalImpl.sol/ProcessorPortalImpl.json"]

type Metadata = { sources?: object; settings?: { compilationTarget?: object; remappings?: string[] } }

function absoluteNames(raw: string): string[] {
	const { sources, settings }: Metadata = JSON.parse(raw)
	const targets = (settings?.remappings ?? []).map((r) => r.slice(r.indexOf("=") + 1))
	return [...Object.keys(sources ?? {}), ...Object.keys(settings?.compilationTarget ?? {}), ...targets].filter((p) => isAbsolute(p))
}

/**
 * Every problem with the contract artifacts under `out` (build-info excluded): a `REQUIRED` artifact
 * absent, a `rawMetadata` missing, containing a needle, or naming an absolute path. Empty means clean.
 */
export function metadataLeaks(out: string, needles: readonly string[]): string[] {
	const files = readdirSync(out, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json") && !f.startsWith("build-info"))
	const problems = REQUIRED.filter((r) => !files.includes(r)).map((r) => `${r}: missing`)
	for (const file of files) {
		const raw: unknown = JSON.parse(readFileSync(join(out, file), "utf8")).rawMetadata
		if (typeof raw !== "string") {
			problems.push(`${file}: no rawMetadata`)
			continue
		}
		for (const n of needles) if (raw.includes(n)) problems.push(`${file}: metadata contains ${n}`)
		const absolute = absoluteNames(raw)
		if (absolute.length > 0) problems.push(`${file}: ${absolute.length} absolute path(s), first ${absolute[0]}`)
	}
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
