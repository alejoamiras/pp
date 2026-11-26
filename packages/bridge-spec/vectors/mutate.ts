/**
 * Proves a parity suite reads the vectors: a control copy must pass in full, then a copy with one
 * expected value flipped per section (a rejection's name swapped) must fail every section's test,
 * each failure naming that vector. Any other failure (compile, setup, read, timeout) fails the run.
 *
 * Usage: bun vectors/mutate.ts --suite ts
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const PKG = fileURLToPath(new URL("..", import.meta.url))
const VECTORS = join(PKG, "vectors", "v1.json")
const TIMEOUT_MS = 600_000

/** The expected value each section's mutation flips. */
const TARGET: Record<string, string> = {
	tags: "value",
	data: "data",
	in: "content",
	out: "content",
	ragequit: "content",
	hash1: "out",
	hash2: "out",
	commitment: "commitment",
	aspLeaf: "leaf",
	leanImt: "root",
	claimKey: "key",
	claimSalt: "salt",
	claimSecretHash: "secretHash",
	birth: "label",
}

type Lang = "ts" | "sol" | "nr"
type TestResult = { status: string; message: string }
type Outcome = { tests: Map<string, TestResult>; error?: string }
type Suite = { lang: Lang; sections: readonly string[]; run(vectorsPath: string, runDir: string): Outcome }
type Row = Record<string, unknown>
type Mutation = { section: string; index: number }

const flipLowBit = (hex: string) => `${hex.slice(0, -1)}${(Number.parseInt(hex.slice(-1), 16) ^ 1).toString(16)}`

/** Rewrites the copy in place; returns which vector of each section changed. */
function mutate(vectors: Record<string, Row[]>, suite: Suite): Mutation[] {
	return suite.sections.map((section) => {
		const rows = vectors[section]
		if (rows === undefined || rows.length === 0) throw new Error(`missing section ${section}`)
		if (section === "rejections") {
			// AmountOutOfRange → FieldOutOfRange keeps the set of names intact, so only that vector fails.
			const index = rows.findIndex((r) => r.error === "AmountOutOfRange" && (r.langs as Lang[]).includes(suite.lang))
			if (index < 0) throw new Error(`no AmountOutOfRange rejection for ${suite.lang}`)
			;(rows[index] as Row).error = "FieldOutOfRange"
			return { section, index }
		}
		// tags[0] is the data tag, which Noir does not hold.
		const index = section === "tags" ? 1 : Math.floor(rows.length / 2)
		const field = TARGET[section] as string
		const row = rows[index] as Row
		row[field] = flipLowBit(row[field] as string)
		return { section, index }
	})
}

function vitestSuite(): Suite {
	return {
		lang: "ts",
		sections: [...Object.keys(TARGET), "rejections"],
		run(vectorsPath, runDir) {
			const report = join(runDir, `report-${Date.now()}.json`)
			const args = ["--bun", "vitest", "run", "src/vectors.test.ts", "--reporter=json", `--outputFile=${report}`]
			const proc = spawnSync("bun", args, {
				cwd: PKG,
				env: { ...process.env, BRIDGE_SPEC_VECTORS: vectorsPath },
				timeout: TIMEOUT_MS,
				encoding: "utf8",
			})
			if (proc.error || proc.signal) return { tests: new Map(), error: `vitest did not finish: ${proc.error ?? proc.signal}` }
			let parsed: {
				testResults?: { message?: string; assertionResults?: { title: string; status: string; failureMessages: string[] }[] }[]
			}
			try {
				parsed = JSON.parse(readFileSync(report, "utf8"))
			} catch {
				return { tests: new Map(), error: `no vitest report:\n${proc.stdout}\n${proc.stderr}` }
			}
			const file = parsed.testResults?.[0]
			const tests = new Map(
				(file?.assertionResults ?? []).map((t) => [t.title, { status: t.status, message: t.failureMessages.join("\n") }]),
			)
			return { tests, error: tests.size === 0 ? `suite did not load: ${file?.message ?? proc.stderr}` : undefined }
		},
	}
}

type ForgeReport = Record<string, { test_results?: Record<string, { status: string; reason: string | null }> }>

/** Needs the pinned forge on PATH; the mutant lives under vectors/, inside foundry.toml's read grant. */
function forgeSuite(): Suite {
	return {
		lang: "sol",
		sections: ["tags", "data", "in", "out", "ragequit", "rejections"],
		run(vectorsPath) {
			const proc = spawnSync("forge", ["test", "--match-contract", "BridgeMessageV1Test", "--json"], {
				cwd: join(PKG, "..", "..", "contracts", "bridge", "evm"),
				env: { ...process.env, BRIDGE_SPEC_VECTORS: vectorsPath },
				timeout: TIMEOUT_MS,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			})
			if (proc.error || proc.signal) return { tests: new Map(), error: `forge did not finish: ${proc.error ?? proc.signal}` }
			let report: ForgeReport
			try {
				report = JSON.parse(proc.stdout.slice(proc.stdout.indexOf("{")))
			} catch {
				return { tests: new Map(), error: `no forge report:\n${proc.stdout.slice(-2000)}\n${proc.stderr.slice(-2000)}` }
			}
			const results = Object.values(report).flatMap((s) => Object.entries(s.test_results ?? {}))
			// `test_in()` reports section `in`; fuzz tests keep their names and must pass in the control run.
			const tests = new Map(
				results.map(([name, r]) => [
					name.replace(/^test_(\w+)\(\)$/, "$1"),
					{ status: r.status === "Success" ? "passed" : "failed", message: r.reason ?? "" },
				]),
			)
			return { tests, error: tests.size === 0 ? `suite did not run:\n${proc.stderr.slice(-2000)}` : undefined }
		},
	}
}

const SUITES: Record<string, () => Suite> = { ts: vitestSuite, sol: forgeSuite }

function verifyControl(suite: Suite, outcome: Outcome): string[] {
	if (outcome.error) return [`control: ${outcome.error}`]
	const problems = [...outcome.tests]
		.filter(([, t]) => t.status !== "passed")
		.map(([name, t]) => `control: ${name} ${t.status}\n${t.message}`)
	for (const section of suite.sections) if (!outcome.tests.has(section)) problems.push(`control: no test for ${section}`)
	return problems
}

function verifyMutant(mutations: Mutation[], outcome: Outcome): string[] {
	if (outcome.error) return [`mutant: ${outcome.error}`]
	return mutations.flatMap(({ section, index }) => {
		const t = outcome.tests.get(section)
		const name = `${section}[${index}]`
		if (t === undefined) return [`mutant: no test for ${section}`]
		if (t.status !== "failed") return [`mutant: ${section} ${t.status} despite ${name} flipped`]
		return t.message.includes(name) ? [] : [`mutant: ${section} failed without naming ${name}:\n${t.message.slice(0, 400)}`]
	})
}

function main(): number {
	const name = process.argv[process.argv.indexOf("--suite") + 1] ?? ""
	const make = SUITES[name]
	if (!process.argv.includes("--suite") || make === undefined) {
		console.error(`usage: bun vectors/mutate.ts --suite ${Object.keys(SUITES).join("|")}`)
		return 2
	}
	const suite = make()
	const runDir = join(PKG, "vectors", ".mutated", `${suite.lang}-${Date.now()}-${process.pid}`)
	mkdirSync(runDir, { recursive: true })
	try {
		const control = join(runDir, "control.json")
		copyFileSync(VECTORS, control)
		const problems = verifyControl(suite, suite.run(control, runDir))
		if (problems.length === 0) {
			const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Record<string, Row[]>
			const mutations = mutate(vectors, suite)
			const mutant = join(runDir, "mutant.json")
			writeFileSync(mutant, JSON.stringify(vectors, null, "\t"))
			problems.push(...verifyMutant(mutations, suite.run(mutant, runDir)))
		}
		for (const p of problems) console.error(p)
		console.log(
			problems.length === 0 ? `mutation ${suite.lang}: control passed, ${suite.sections.length} sections caught` : "mutation failed",
		)
		return problems.length === 0 ? 0 : 1
	} finally {
		rmSync(runDir, { recursive: true, force: true })
	}
}

process.exit(main())
