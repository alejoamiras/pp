/**
 * `bun run nightly`: suites too slow for a pull request. `.github/workflows/nightly.yml` runs this file
 * from the branch it tests (bridge-v1 when it exists, else main), so a lane adds its deep suite here in
 * its own branch, without touching main's workflow. Every suite must pass at least one test: a filter
 * that matches nothing exits 0 and would read as green.
 *
 *   bun run nightly [suite...]   every suite, or only the named ones
 */
import { spawn } from "node:child_process"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

export interface Suite {
	name: string
	/** Commands run from the repository root before the suite, in order; a failure fails the suite. */
	prepare?: string[][]
	/** Repo-relative working directory of `command`. */
	cwd: string
	command: string[]
	env?: Record<string, string>
	/** How many tests the suite's output shows passing. */
	passed: (output: string) => number
	/** The exact count the suite must pass; a skipped or deleted test fails it. */
	expected?: number
}

/** Sums forge's per-contract "Suite result: ok. N passed;" lines. */
export const forgePassed = (output: string): number =>
	[...output.matchAll(/Suite result: \w+\. (\d+) passed;/g)].reduce((n, m) => n + Number(m[1]), 0)

/** Reads vitest's last "Tests  N passed" summary line; a CI environment turns its colors on. */
export const vitestPassed = (output: string): number => {
	const summary = [...Bun.stripANSI(output).matchAll(/^\s*Tests\s+(.*)$/gm)].at(-1)?.[1] ?? ""
	return Number(summary.match(/(\d+) passed/)?.[1] ?? 0)
}

// $0 is the suite's name, $1 the bound in seconds, the rest the command. No `exec`: the shell outlives
// a killed command to print the seed again, and `|| code=$?` keeps it going under an inherited errexit.
const BOUNDED = `case "\${FC_SEED:-random}" in random) FC_SEED=$(( (RANDOM << 15) | RANDOM ));; esac
export FC_SEED
bound=$1
shift
echo "$0: FC_SEED=$FC_SEED, bound \${bound}s"
code=0
timeout -s KILL "$bound" "$@" || code=$?
[ "$code" -eq 0 ] || echo "$0: exited $code (137: the bound or another SIGKILL); replay with FC_SEED=$FC_SEED" >&2
exit "$code"`

/**
 * A suite under one wall-clock bound, `timeout -s KILL`, with `FC_SEED` (the caller's, else a drawn one)
 * printed before it starts and again when it fails. It passes only when exactly `expected` tests pass, so
 * a skipped or deleted test fails it. Only for commands that start no detached process group: the kill
 * reaches `timeout`'s own group alone and runs no cleanup, so a booted stack or sandbox would be orphaned.
 * That group is not the terminal's, so a Ctrl-C on a local run leaves the command going until its bound.
 */
export function boundedSuite(s: {
	name: string
	cwd: string
	argv: string[]
	minutes: number
	expected: number
	env?: Record<string, string>
	count?: (output: string) => number
}): Suite {
	return {
		name: s.name,
		cwd: s.cwd,
		command: ["bash", "-c", BOUNDED, s.name, String(s.minutes * 60), ...s.argv],
		env: s.env,
		passed: s.count ?? vitestPassed,
		expected: s.expected,
	}
}

/** Reads `vectors/fresh.ts`'s closing line. */
const freshPassed = (output: string): number => Number(/^fresh vectors: (\d+) tests passed/m.exec(output)?.[1] ?? 0)

export const SUITES: Suite[] = [
	// contracts/bridge/evm owns the script and the Foundry `nightly` profile it runs; the libraries and
	// remappings it assumes are prepared here, as the pull-request job prepares them.
	{
		name: "bridge-l1-fuzz-invariant",
		prepare: [
			["bash", "contracts/bridge/evm/scripts/install-libs.sh"],
			["bun", "packages/bridge-core/scripts/gen-remappings.ts"],
		],
		cwd: ".",
		command: ["bash", "contracts/bridge/evm/scripts/nightly.sh"],
		passed: forgePassed,
	},
	// packages/local-stack owns the case: a stack left idle for 1920 s moves neither chain. It boots the
	// pool, so the workflow fetches it first.
	{
		name: "local-stack-long-idle",
		cwd: "packages/local-stack",
		command: ["bun", "run", "test:integration:long"],
		passed: vitestPassed,
	},
	// Property files at ten times their pull-request runs; each bound covers its tests' timeouts at that scale.
	boundedSuite({
		name: "label-paths-properties",
		cwd: "packages/label-paths",
		argv: ["bun", "run", "test", "src/codec.property.test.ts"],
		minutes: 5,
		expected: 4,
		env: { FC_RUNS_SCALE: "10" },
	}),
	boundedSuite({
		name: "bridge-spec-properties",
		cwd: "packages/bridge-spec",
		argv: ["bun", "run", "test", "src/lean-imt.property.test.ts"],
		minutes: 7,
		expected: 4,
		env: { FC_RUNS_SCALE: "10", FC_DEEP: "1" },
	}),
	// The forge and Noir parity suites against a corpus built from FC_SEED. Its preparation and the pin
	// check of what nargo fetched run inside the same bound.
	boundedSuite({
		name: "bridge-spec-fresh-vectors",
		cwd: ".",
		argv: [
			"bash",
			"-c",
			[
				"bash contracts/bridge/evm/scripts/install-libs.sh",
				"bun packages/bridge-core/scripts/gen-remappings.ts",
				"bun packages/bridge-spec/vectors/fresh.ts",
				"bun scripts/ci-cd/crates.ts check-pins keystone",
			].join(" && "),
		],
		minutes: 4,
		expected: 34,
		count: freshPassed,
	}),
	// The bridge client's model test and properties. The model test's coverage floor runs at the pull-request seed only.
	boundedSuite({
		name: "bridge-client-model",
		cwd: "packages/bridge-core",
		argv: [
			"bun",
			"run",
			"test",
			"src/client/submit.model.test.ts",
			"src/client/attempts.property.test.ts",
			"src/client/boundary.property.test.ts",
			"src/l1-gas.property.test.ts",
			"src/client/chunks.property.test.ts",
			"src/client/exits.property.test.ts",
		],
		minutes: 10,
		expected: 21,
		env: { FC_RUNS_SCALE: "10" },
	}),
]

/** Why a finished suite failed, or undefined when it passed. */
export function verdict(suite: Suite, status: number | null, output: string): string | undefined {
	if (status !== 0) return `${suite.name}: exited ${status}`
	const n = suite.passed(output)
	if (n === 0) return `${suite.name}: matched no test`
	if (suite.expected !== undefined && n !== suite.expected) return `${suite.name}: ${n} tests passed, expected ${suite.expected}`
	return undefined
}

/** Runs a command with its output streamed through and kept. */
function run(command: string[], cwd: string, env: Record<string, string> = {}): Promise<{ status: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(command[0], command.slice(1), { cwd: join(ROOT, cwd), env: { ...process.env, ...env } })
		let output = ""
		const keep = (sink: NodeJS.WriteStream) => (chunk: Buffer) => {
			output += chunk
			sink.write(chunk)
		}
		child.stdout.on("data", keep(process.stdout))
		child.stderr.on("data", keep(process.stderr))
		child.on("error", (e) => resolve({ status: null, output: `${output}${e.message}` }))
		child.on("close", (status) => resolve({ status, output }))
	})
}

async function runSuite(suite: Suite): Promise<string | undefined> {
	console.log(`\n=== ${suite.name} ===`)
	for (const step of suite.prepare ?? []) {
		const { status } = await run(step, ".")
		if (status !== 0) return `${suite.name}: \`${step.join(" ")}\` exited ${status}`
	}
	const { status, output } = await run(suite.command, suite.cwd, suite.env)
	return verdict(suite, status, output)
}

if (import.meta.main) {
	const names = process.argv.slice(2)
	const unknown = names.filter((n) => !SUITES.some((s) => s.name === n))
	if (unknown.length) {
		console.error(`unknown suite: ${unknown.join(", ")}; known: ${SUITES.map((s) => s.name).join(", ")}`)
		process.exit(2)
	}
	const failures: string[] = []
	for (const suite of SUITES.filter((s) => !names.length || names.includes(s.name))) {
		const failure = await runSuite(suite)
		if (failure) failures.push(failure)
	}
	for (const f of failures) console.error(`✖ ${f}`)
	process.exit(failures.length ? 1 : 0)
}
