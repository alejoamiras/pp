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
}

/** Sums forge's per-contract "Suite result: ok. N passed;" lines. */
export const forgePassed = (output: string): number =>
	[...output.matchAll(/Suite result: \w+\. (\d+) passed;/g)].reduce((n, m) => n + Number(m[1]), 0)

/** Reads vitest's last "Tests  N passed" summary line; a CI environment turns its colors on. */
export const vitestPassed = (output: string): number => {
	const summary = [...Bun.stripANSI(output).matchAll(/^\s*Tests\s+(.*)$/gm)].at(-1)?.[1] ?? ""
	return Number(summary.match(/(\d+) passed/)?.[1] ?? 0)
}

export const SUITES: Suite[] = [
	// contracts/bridge/evm owns the script and the Foundry `nightly` profile it runs; the libraries and
	// remappings it assumes are prepared here, as the pull-request job prepares them.
	{
		name: "bridge-l1-fuzz-invariant",
		prepare: [["bash", "contracts/bridge/evm/scripts/install-libs.sh"], ["bun", "packages/bridge-core/scripts/gen-remappings.ts"]],
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
]

/** Why a finished suite failed, or undefined when it passed. */
export function verdict(suite: Suite, status: number | null, output: string): string | undefined {
	if (status !== 0) return `${suite.name}: exited ${status}`
	if (suite.passed(output) === 0) return `${suite.name}: matched no test`
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
