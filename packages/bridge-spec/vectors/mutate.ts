/**
 * Proves a parity suite reads the vectors: a control copy must pass in full, then a copy with one
 * expected value flipped per section (a rejection's name swapped) must fail every section's test,
 * each failure naming that vector. Any other failure (compile, setup, read, timeout) fails the run.
 *
 * Usage: bun vectors/mutate.ts --suite ts|sol|nr
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AZTEC_DIR, type NargoTest, nargoTest } from "./nargo"
import { renderNoir } from "./render-nr"

export const PKG = fileURLToPath(new URL("..", import.meta.url))
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
/**
 * `exitCode` is the runner's own status: a report saying "passed" from a process that failed is no pass.
 * `tests` is keyed by section; `raw` keeps every test the runner reported under its own name (forge's prefixed
 * by its contract), duplicates included.
 */
export type Outcome = {
	tests: Map<string, TestResult>
	raw: readonly (TestResult & { name: string })[]
	exitCode: number | null
	error?: string
}
export type Suite = { lang: Lang; sections: readonly string[]; run(vectorsPath: string, runDir: string): Outcome }
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
			if (proc.error || proc.signal)
				return { tests: new Map(), raw: [], exitCode: null, error: `vitest did not finish: ${proc.error ?? proc.signal}` }
			let parsed: {
				testResults?: { message?: string; assertionResults?: { title: string; status: string; failureMessages: string[] }[] }[]
			}
			try {
				parsed = JSON.parse(readFileSync(report, "utf8"))
			} catch {
				return { tests: new Map(), raw: [], exitCode: proc.status, error: `no vitest report:\n${proc.stdout}\n${proc.stderr}` }
			}
			const file = parsed.testResults?.[0]
			const raw = (file?.assertionResults ?? []).map((t) => ({
				name: t.title,
				status: t.status,
				message: t.failureMessages.join("\n"),
			}))
			const tests = new Map(raw.map(({ name, ...t }) => [name, t]))
			return {
				tests,
				raw,
				exitCode: proc.status,
				error: tests.size === 0 ? `suite did not load: ${file?.message ?? proc.stderr}` : undefined,
			}
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
			if (proc.error || proc.signal)
				return { tests: new Map(), raw: [], exitCode: null, error: `forge did not finish: ${proc.error ?? proc.signal}` }
			let report: ForgeReport
			try {
				report = JSON.parse(proc.stdout.slice(proc.stdout.indexOf("{")))
			} catch {
				return {
					tests: new Map(),
					raw: [],
					exitCode: proc.status,
					error: `no forge report:\n${proc.stdout.slice(-2000)}\n${proc.stderr.slice(-2000)}`,
				}
			}
			const results = Object.entries(report).flatMap(([contract, s]) =>
				Object.entries(s.test_results ?? {}).map(([name, r]) => ({
					contract,
					name,
					status: r.status === "Success" ? "passed" : "failed",
					message: r.reason ?? "",
				})),
			)
			// `test_in()` reports section `in`; fuzz tests keep their names and must pass in the control run.
			const tests = new Map(results.map(({ name, status, message }) => [name.replace(/^test_(\w+)\(\)$/, "$1"), { status, message }]))
			const raw = results.map(({ contract, name, status, message }) => ({ name: `${contract}:${name}`, status, message }))
			return {
				tests,
				raw,
				exitCode: proc.status,
				error: tests.size === 0 ? `suite did not run:\n${proc.stderr.slice(-2000)}` : undefined,
			}
		},
	}
}

const NR_SECTION_OF: Record<string, string> = {
	v1_tags: "tags",
	v1_in: "in",
	v1_out: "out",
	v1_ragequit: "ragequit",
	v1_hash1: "hash1",
	v1_hash2: "hash2",
	v1_commitment: "commitment",
	v1_asp_leaf: "aspLeaf",
	v1_lean_imt: "leanImt",
	v1_claim_secret_hash: "claimSecretHash",
	v1_birth: "birth",
}

/** Copies keystone and its path dependencies (no target/) so the generated module can be swapped. */
function copyKeystone(into: string): string {
	const deps = [...readFileSync(join(AZTEC_DIR, "keystone", "Nargo.toml"), "utf8").matchAll(/path = "\.\.\/([\w-]+)"/g)].map(
		(m) => m[1] as string,
	)
	for (const crate of ["keystone", ...deps]) {
		cpSync(join(AZTEC_DIR, crate), join(into, crate), { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("target") })
	}
	return join(into, "keystone")
}

/** Section tests by section; each per-vector rejection test is `rejections[i]` and folds into `rejections`. */
function bySection(results: readonly NargoTest[]): Map<string, TestResult> {
	const tests = new Map<string, TestResult>()
	const failedRejections: string[] = []
	for (const t of results) {
		const status = t.event === "ok" ? "passed" : "failed"
		const rejection = /^v1_rejection_(\d+)_/.exec(t.name)
		const key = rejection === null ? (NR_SECTION_OF[t.name] ?? t.name) : `rejections[${Number(rejection[1])}]`
		tests.set(key, { status, message: t.message })
		if (rejection !== null && status === "failed") failedRejections.push(`${key} ${t.name}\n${t.message}`)
	}
	tests.set("rejections", { status: failedRejections.length === 0 ? "passed" : "failed", message: failedRejections.join("\n") })
	return tests
}

/** Each run gets a fresh copy under ~/.cache/pp/spec/mutate/; only that directory is removed. */
function nargoSuite(): Suite {
	return {
		lang: "nr",
		sections: [...Object.values(NR_SECTION_OF), "rejections"],
		run(vectorsPath) {
			const dir = join(homedir(), ".cache", "pp", "spec", "mutate", `${Date.now()}-${process.pid}`)
			try {
				const keystone = copyKeystone(dir)
				writeFileSync(join(keystone, "src", "vectors_v1.nr"), renderNoir(JSON.parse(readFileSync(vectorsPath, "utf8"))))
				// Only the generated module: the mutation is in it, and the legacy keystone tests run in vectors:nargo.
				const run = nargoTest(keystone, { filter: "vectors_v1::", timeoutMs: TIMEOUT_MS })
				const raw = run.tests.map((t) => ({ name: t.name, status: t.event === "ok" ? "passed" : "failed", message: t.message }))
				return { tests: bySection(run.tests), raw, exitCode: run.exitCode, error: run.error }
			} finally {
				rmSync(dir, { recursive: true, force: true })
			}
		},
	}
}

export const SUITES = { ts: vitestSuite, sol: forgeSuite, nr: nargoSuite } satisfies Record<Lang, () => Suite>

/** Problems with a run on unchanged vectors; empty means it passed in full. */
export function verifyControl(suite: Suite, outcome: Outcome): string[] {
	if (outcome.error) return [`control: ${outcome.error}`]
	if (outcome.exitCode !== 0) return [`control: runner exited ${outcome.exitCode}`]
	const problems = [...outcome.tests]
		.filter(([, t]) => t.status !== "passed")
		.map(([name, t]) => `control: ${name} ${t.status}\n${t.message}`)
	for (const section of suite.sections) if (!outcome.tests.has(section)) problems.push(`control: no test for ${section}`)
	return problems
}

function verifyMutant(mutations: Mutation[], outcome: Outcome, control: Outcome): string[] {
	if (outcome.error) return [`mutant: ${outcome.error}`]
	if (outcome.exitCode === 0) return ["mutant: runner exited 0 although vectors were flipped"]
	const missing = [...control.tests.keys()].filter((name) => !outcome.tests.has(name)).map((name) => `mutant: ${name} did not run`)
	const expected = new Set(mutations.flatMap(({ section, index }) => [section, `${section}[${index}]`]))
	const unexpected = [...outcome.tests]
		.filter(([name, t]) => t.status !== "passed" && !expected.has(name))
		.map(([name, t]) => `mutant: ${name} ${t.status} with none of its vectors flipped\n${t.message.slice(0, 400)}`)
	const caught = mutations.flatMap(({ section, index }) => {
		const t = outcome.tests.get(section)
		const name = `${section}[${index}]`
		if (t === undefined) return [`mutant: no test for ${section}`]
		if (t.status !== "failed") return [`mutant: ${section} ${t.status} despite ${name} flipped`]
		return t.message.includes(name) ? [] : [`mutant: ${section} failed without naming ${name}:\n${t.message.slice(0, 400)}`]
	})
	return [...missing, ...unexpected, ...caught]
}

function main(): number {
	const name = process.argv[process.argv.indexOf("--suite") + 1] ?? ""
	const make = (SUITES as Record<string, () => Suite>)[name]
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
		const controlOutcome = suite.run(control, runDir)
		const problems = verifyControl(suite, controlOutcome)
		if (problems.length === 0) {
			const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Record<string, Row[]>
			const mutations = mutate(vectors, suite)
			const mutant = join(runDir, "mutant.json")
			writeFileSync(mutant, JSON.stringify(vectors, null, "\t"))
			problems.push(...verifyMutant(mutations, suite.run(mutant, runDir), controlOutcome))
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

if (import.meta.main) process.exit(main())
