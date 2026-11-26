/**
 * Renders `bun audit --json` as the advisory step's job summary: one row per advisory, those a
 * workspace's own copy is exposed to first (a bump there is ours to make), then by severity. A
 * workspace that declares the package but resolves a fixed version is not named: the flagged copy is
 * then another package's.
 *
 *   bun audit --json > audit.json; bun scripts/ci-cd/audit-summary.ts audit.json >> "$GITHUB_STEP_SUMMARY"
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const SEVERITY = ["critical", "high", "moderate", "low", "info"]

export interface Advisory {
	title: string
	url: string
	severity: string
	vulnerable_versions: string
}

export type AuditReport = Record<string, Advisory[]>

/** A workspace's direct dependency and the version it resolves to. */
export interface Declared {
	workspace: string
	version: string
}

/** Every direct dependency of every workspace, keyed by the dependency's name. */
export function directDependencies(root = ROOT): Map<string, Declared[]> {
	const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"))
	const declared = new Map<string, Declared[]>()
	const patterns: string[] = read("package.json").workspaces ?? []
	for (const manifest of patterns.flatMap((p) => [...new Bun.Glob(`${p}/package.json`).scanSync({ cwd: root })])) {
		const pkg = read(manifest)
		for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
			const installed = join(dirname(manifest), "node_modules", dep, "package.json")
			const version = existsSync(join(root, installed)) ? read(installed).version : "unknown"
			declared.set(dep, [...(declared.get(dep) ?? []), { workspace: pkg.name, version }])
		}
	}
	return declared
}

/** The workspaces whose own copy is in the advisory's range; an unreadable version counts as exposed. */
export function exposedWorkspaces(declared: Declared[] | undefined, range: string): string[] {
	return (declared ?? []).filter((d) => d.version === "unknown" || Bun.semver.satisfies(d.version, range)).map((d) => d.workspace)
}

const rank = (severity: string) => {
	const i = SEVERITY.indexOf(severity)
	return i === -1 ? SEVERITY.length : i
}
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ")

export function renderSummary(report: AuditReport, declared: Map<string, Declared[]>, exitCode: number): string {
	const rows = Object.entries(report)
		.flatMap(([pkg, advisories]) => advisories.map((a) => ({ pkg, a, direct: exposedWorkspaces(declared.get(pkg), a.vulnerable_versions) })))
		.sort((x, y) => Number(y.direct.length > 0) - Number(x.direct.length > 0) || rank(x.a.severity) - rank(y.a.severity) || x.pkg.localeCompare(y.pkg))
	const counts = SEVERITY.map((s) => [s, rows.filter((r) => r.a.severity === s).length] as const).filter(([, n]) => n > 0)
	const lines = [
		`## bun audit (advisory, exit=${exitCode})`,
		"",
		rows.length === 0 ? "No known vulnerabilities." : `${rows.length} findings: ${counts.map(([s, n]) => `${n} ${s}`).join(", ")}.`,
	]
	if (rows.length === 0) return `${lines.join("\n")}\n`
	lines.push("", "| severity | package | vulnerable | declared by | advisory |", "|---|---|---|---|---|")
	for (const { pkg, a, direct } of rows) {
		const by = direct.length ? direct.join(", ") : "transitive"
		lines.push(`| ${a.severity} | \`${pkg}\` | \`${cell(a.vulnerable_versions)}\` | ${by} | [${cell(a.title)}](${a.url}) |`)
	}
	return `${lines.join("\n")}\n`
}

if (import.meta.main) {
	const [path, code] = process.argv.slice(2)
	if (!path) {
		console.error("usage: bun scripts/ci-cd/audit-summary.ts <audit.json> [bun audit's exit code]")
		process.exit(2)
	}
	const report = JSON.parse(readFileSync(path, "utf8")) as AuditReport
	process.stdout.write(renderSummary(report, directDependencies(), Number(code ?? 0)))
}
