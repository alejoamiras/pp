/**
 * Nightly differential: the TS reference builds the corpus from a fresh seed, and the Solidity and Noir
 * parity suites must accept it, every test each one defines running and passing by name. The corpus is
 * written under the git-ignored `vectors/.mutated/` and removed afterwards; it is never committed.
 *
 * Usage: [FC_SEED=<non-negative integer>] bun packages/bridge-spec/vectors/fresh.ts   (forge on PATH, lib/ installed)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildCorpus } from "./corpus"
import { type Outcome, PKG, SUITES, verifyControl } from "./mutate"
import { REPO } from "./nargo"
import { noirTestNames } from "./render-nr"

const FORGE_TEST = join(REPO, "contracts", "bridge", "evm", "test", "BridgeMessageV1.t.sol")

function seedFromEnv(): number {
	const raw = process.env.FC_SEED
	if (raw === undefined || raw === "" || raw === "random") return Math.floor(Math.random() * 2 ** 31)
	const n = Number(raw)
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`FC_SEED must be a non-negative integer, got ${raw}`)
	return n
}

/** Every test the forge suite defines, read from its source so a test added there is required here too. */
function forgeTestNames(): string[] {
	return [...readFileSync(FORGE_TEST, "utf8").matchAll(/function (test\w*)\(/g)].map((m) => m[1] as string)
}

/** The run must hold exactly the expected names, each once, each passed; forge's `(types)` suffix is ignored. */
function byName(lang: string, outcome: Outcome, expected: readonly string[]): string[] {
	const ran = outcome.raw.map((t) => t.name.replace(/\(.*$/, "")).sort()
	const want = [...expected].sort()
	const problems = outcome.raw
		.filter((t) => t.status !== "passed")
		.map((t) => `${lang}: ${t.name} ${t.status}\n${t.message.slice(0, 2000)}`)
	if (ran.join("\n") !== want.join("\n")) {
		const missing = want.filter((n) => !ran.includes(n))
		const unexpected = ran.filter((n) => !want.includes(n))
		problems.push(`${lang}: ran ${ran.length} tests, expected ${want.length}; missing [${missing}], unexpected [${unexpected}]`)
	}
	return problems
}

async function main(): Promise<number> {
	const seed = seedFromEnv()
	console.log(`fresh vectors: seed ${seed}`)
	const { counts, noirTests, ...sections } = await buildCorpus(noirTestNames, seed)
	const dir = join(PKG, "vectors", ".mutated", `fresh-${process.pid}`)
	mkdirSync(dir, { recursive: true })
	try {
		const vectors = join(dir, "v1.json")
		writeFileSync(vectors, JSON.stringify({ version: 1, ...sections, counts, noirTests }))
		const problems: string[] = []
		let passed = 0
		for (const [lang, expected] of [
			["sol", forgeTestNames()],
			["nr", noirTests],
		] as const) {
			const suite = SUITES[lang]()
			const outcome = suite.run(vectors, dir)
			const found = [...verifyControl(suite, outcome), ...byName(lang, outcome, expected)]
			problems.push(...found)
			if (found.length === 0) passed += outcome.raw.length
		}
		for (const p of problems) console.error(p)
		if (problems.length > 0) {
			console.error(`fresh vectors failed (seed ${seed}); replay: FC_SEED=${seed} bun packages/bridge-spec/vectors/fresh.ts`)
			return 1
		}
		console.log(`fresh vectors: ${passed} tests passed (seed ${seed})`)
		return 0
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// Barretenberg keeps worker threads alive, so the process exits explicitly.
process.exit(await main())
