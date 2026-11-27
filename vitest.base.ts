/**
 * Shared `test` options every workspace vitest config spreads in, and the property-test parameters.
 * No imports on purpose: it resolves identically under the hoisted and the isolated linker.
 */
export const sharedTest = {
	// STOPGAP until the installed vitest contains vitest-dev/vitest#10363 (≥ 5.0.0-beta.3).
	// Bun's ES-module namespace objects answer `"__esModule" in ns` (Node: false), so vitest 4's
	// default interop replaces an externalized module by its `default` — zod@4's default IS a
	// namespace and `z` vanishes. Off, named exports of CJS deps follow each runtime's own loader
	// (no vitest fallback); the Node soak baselines prove nothing here depends on that fallback.
	// Retire: delete this key and re-run the Bun soak matrix (scripts/ci-cd/test-soak).
	deps: { interopDefault: false },
} as const

const PR_SEED = 20261127

function envInt(name: string, fallback: number, min: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	const n = Number(raw)
	if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer ≥ ${min}, got ${raw}`)
	return n
}

function seedFromEnv(): number {
	if (process.env.FC_SEED === "random") return Math.floor(Math.random() * 2 ** 31)
	return envInt("FC_SEED", PR_SEED, -(2 ** 31))
}

/** `packages/<name>` and the path below it, for a replay command run from the repository root. */
function where(fileUrl: string): { pkg: string; file: string } {
	const path = new URL(fileUrl).pathname
	const m = /\/(packages\/[^/]+)\/(.+)$/.exec(path)
	return m ? { pkg: m[1] as string, file: m[2] as string } : { pkg: ".", file: path }
}

/**
 * fast-check parameters for one property, plus the vitest timeout that must wrap it.
 *
 * A pull request runs the fixed seed and `numRuns`. `FC_SEED` (an integer, or `random`) and `FC_RUNS_SCALE`
 * (multiplies runs and the time limit) widen a run; `FC_PATH` and `FC_REPLAY_PATH` replay a printed failure.
 * The time limit counts as a failure, so a slow property never passes by running fewer cases.
 *
 * @param fileUrl the test file's `import.meta.url`, to print a replay command
 * @param name the test's name, for `-t`
 * @throws Error when an `FC_*` variable is malformed
 */
export function propertyParams(fileUrl: string, name: string, numRuns: number, timeLimitMs: number) {
	const seed = seedFromEnv()
	const scale = envInt("FC_RUNS_SCALE", 1, 1)
	const path = process.env.FC_PATH || undefined
	const replayPath = process.env.FC_REPLAY_PATH || undefined
	const limit = timeLimitMs * scale
	const { pkg, file } = where(fileUrl)
	// stderr directly: vitest under `bun --bun` drops console output from test files.
	process.stderr.write(
		`fast-check "${name}": seed=${seed} runs=${numRuns * scale}; replay: FC_SEED=${seed} FC_PATH=<path>` +
			` [FC_REPLAY_PATH=<replayPath>] bun run --cwd ${pkg} test ${file} -t "${name}"\n`,
	)
	return {
		fc: { seed, numRuns: numRuns * scale, path, interruptAfterTimeLimit: limit, markInterruptAsFailure: true },
		replayPath,
		/** Above the time limit, so fast-check reports its seed before vitest's timer ends the test. */
		testTimeout: limit + 15_000,
	}
}
