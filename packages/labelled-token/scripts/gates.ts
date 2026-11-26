/**
 * Static app-circuit gates of every private function, from `aztec profile gates`.
 *
 *   gates.ts           profile the committed token artifact into bench/gates.json
 *   gates.ts --stock   profile the stock aztec-standards Token into bench/stock-gates.json
 *   gates.ts --check   profile again; fail if bench/gates.json differs or a function is over bench/budget.json
 *
 * CI's parity job proves the committed artifact compiles from source to the same class id, which
 * fixes every private function's circuit, so profiling the committed artifact measures the source.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"

/** Gates per function name. */
export type Gates = Record<string, number>

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..")
const bench = join(pkg, "bench")
const tokenArtifact = join(pkg, "../../contracts/bridge/aztec/labelled_token/target/labelled_token-LabelledToken.json")

/** Profiles one artifact. The CLI reads every JSON in its directory, so the artifact is copied alone. */
export function profile(artifact: string): Gates {
	const home = process.env.AZTEC_HOME ?? join(homedir(), ".aztec/versions/6.0.0")
	const cache = join(homedir(), ".cache/pp")
	mkdirSync(cache, { recursive: true })
	const dir = mkdtempSync(join(cache, "gates-"))
	try {
		copyFileSync(artifact, join(dir, "artifact.json"))
		const run = spawnSync(join(home, "node_modules/.bin/aztec"), ["profile", "gates", "--json", dir], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${home}/bin:${home}/node_modules/.bin:${process.env.PATH ?? ""}` },
			maxBuffer: 64 * 1024 * 1024,
		})
		if (run.status !== 0) throw new Error(`aztec profile gates failed (${run.status}): ${run.stderr}`)
		const rows = (run.stdout.trim() === "" ? [] : JSON.parse(run.stdout)) as { name: string; gates: number }[]
		const entries = rows.map((r): [string, number] => [r.name.slice(r.name.indexOf("::") + 2), r.gates])
		return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/** Every function must have a budget and stay within it. */
export function overBudget(gates: Gates, budget: Gates): string[] {
	return Object.entries(gates).flatMap(([fn, n]) => {
		const cap = budget[fn]
		if (cap === undefined) return [`${fn}: no budget`]
		return n > cap ? [`${fn}: ${n} gates, budget ${cap}`] : []
	})
}

/** Differences between a fresh profile and the committed one, in both directions. */
export function drift(fresh: Gates, committed: Gates): string[] {
	const names = new Set([...Object.keys(fresh), ...Object.keys(committed)])
	return [...names].flatMap((fn) =>
		fresh[fn] === committed[fn] ? [] : [`${fn}: committed ${committed[fn] ?? "none"}, measured ${fresh[fn] ?? "none"}`],
	)
}

const readGates = (name: string): Gates => JSON.parse(readFileSync(join(bench, name), "utf8")) as Gates
const writeGates = (name: string, gates: Gates) => writeFileSync(join(bench, name), `${JSON.stringify(gates, null, "\t")}\n`)

function check(): number {
	const fresh = profile(tokenArtifact)
	const problems = [...drift(fresh, readGates("gates.json")), ...overBudget(fresh, readGates("budget.json"))]
	for (const p of problems) console.error(`✖ ${p}`)
	if (problems.length === 0) console.log(`✔ ${Object.keys(fresh).length} private functions match bench/gates.json and their budgets`)
	return problems.length === 0 ? 0 : 1
}

if (import.meta.main) {
	const mode = process.argv[2]
	if (mode === "--check") process.exit(check())
	if (mode === "--stock") {
		const stock = resolvePackageAsset("@aztec-foundation/aztec-standards", "target/token_contract-Token.json", {
			from: import.meta.url,
		})
		writeGates("stock-gates.json", profile(stock))
	} else {
		writeGates("gates.json", profile(tokenArtifact))
	}
}
