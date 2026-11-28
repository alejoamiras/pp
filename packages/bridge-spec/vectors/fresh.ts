/**
 * Nightly differential: the TS reference builds a corpus from each fresh seed, and the Solidity and Noir
 * parity suites must accept it, every test each one defines running and passing by name. Each corpus is
 * written under the git-ignored `vectors/.mutated/` and removed afterwards; it is never committed.
 *
 * Usage: [FC_SEED=<non-negative integer>] [FC_RUNS_SCALE=<seeds, default 1>] bun packages/bridge-spec/vectors/fresh.ts
 * (forge on PATH, lib/ installed). The seeds are FC_SEED, FC_SEED + 1, …; each is printed with its own replay.
 * `--list` prints how many tests those seeds' runs must pass, building each corpus but running neither suite.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildCorpus } from "./corpus"
import { byName, FORGE_TESTS, PKG, SUITES, verifyControl } from "./mutate"
import { noirTestNames } from "./render-nr"

function seedFromEnv(): number {
	const raw = process.env.FC_SEED
	if (raw === undefined || raw === "" || raw === "random") return Math.floor(Math.random() * 2 ** 31)
	const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
	if (!Number.isSafeInteger(n)) throw new Error(`FC_SEED must be a non-negative integer, got ${raw}`)
	return n
}

/** `FC_RUNS_SCALE` consecutive seeds from `FC_SEED`, each a corpus of its own. */
function seedsFromEnv(): number[] {
	const base = seedFromEnv()
	const raw = process.env.FC_RUNS_SCALE
	const n = raw === undefined || raw === "" ? 1 : /^\d+$/.test(raw) ? Number(raw) : Number.NaN
	if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(base + n - 1))
		throw new Error(`FC_RUNS_SCALE must be a positive integer that keeps FC_SEED + it safe, got ${raw}`)
	return Array.from({ length: n }, (_, k) => base + k)
}

const replay = (seed: number) => `FC_SEED=${seed} bun packages/bridge-spec/vectors/fresh.ts`

/** The Solidity and Noir runs of one seed's corpus: how many tests passed, and what went wrong. */
async function checkSeed(seed: number): Promise<{ passed: number; problems: string[] }> {
	const { counts, noirTests, ...sections } = await buildCorpus(noirTestNames, seed)
	const dir = join(PKG, "vectors", ".mutated", `fresh-${process.pid}-${seed}`)
	mkdirSync(dir, { recursive: true })
	try {
		const vectors = join(dir, "v1.json")
		writeFileSync(vectors, JSON.stringify({ version: 1, ...sections, counts, noirTests }))
		const problems: string[] = []
		let passed = 0
		for (const [lang, expected] of [
			["sol", FORGE_TESTS],
			["nr", noirTests],
		] as const) {
			const suite = SUITES[lang]()
			const outcome = suite.run(vectors, dir)
			const found = [...verifyControl(suite, outcome), ...byName(lang, outcome, expected)]
			problems.push(...found)
			if (found.length === 0) passed += outcome.raw.length
		}
		return { passed, problems }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/** How many tests a full run of these seeds requires to pass, with neither forge nor nargo run. */
async function list(seeds: readonly number[]): Promise<number> {
	let total = 0
	for (const seed of seeds) total += FORGE_TESTS.length + (await buildCorpus(noirTestNames, seed)).noirTests.length
	console.log(`fresh vectors: ${total} tests listed (seeds ${seeds.join(", ")})`)
	return 0
}

async function main(): Promise<number> {
	const seeds = seedsFromEnv()
	if (process.argv.includes("--list")) return list(seeds)
	const failed: number[] = []
	let passed = 0
	for (const [k, seed] of seeds.entries()) {
		console.log(`fresh vectors: seed ${seed} (${k + 1} of ${seeds.length}); replay: ${replay(seed)}`)
		const run = await checkSeed(seed)
		for (const p of run.problems) console.error(p)
		if (run.problems.length > 0) failed.push(seed)
		passed += run.passed
	}
	if (failed.length > 0) {
		for (const seed of failed) console.error(`fresh vectors failed (seed ${seed}); replay: ${replay(seed)}`)
		return 1
	}
	console.log(`fresh vectors: ${passed} tests passed (seeds ${seeds.join(", ")})`)
	return 0
}

// Barretenberg keeps worker threads alive, so the process exits explicitly.
process.exit(await main())
