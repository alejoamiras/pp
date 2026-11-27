import { expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { hideCheckout, JOBS, ROOT, stepsOf } from "../unfetched"

const workflow = (file: string) => readFileSync(join(ROOT, ".github/workflows", file), "utf8")
type Workflow = { jobs: Record<string, { uses?: string; steps?: { uses?: string; run?: string }[] }> }
const parse = (file: string) => Bun.YAML.parse(workflow(file)) as Workflow

/** Quality's and Web's jobs that run no `ppv2-fetch` and that test:unfetched leaves out, with why. */
const LEFT_OUT: Record<string, string> = {
	"pr-quick.yml changes": "a path filter",
	"pr-quick.yml commitlint": "lints commit messages",
	"pr-quick.yml status": "an aggregator",
	"pr-quick.yml build-e2e-kit": "@pp/e2e-kit and its workspace dependencies declare no @pp/pp-env",
	"web.yml changes": "a path filter",
	"web.yml e2e": "needs Aztec, Foundry and Playwright and boots a sandbox (`bun run --cwd apps/web e2e`)",
	"web.yml status": "an aggregator",
}

type Job = { key: string; steps: { uses?: string; run?: string }[] }

/**
 * Every job a workflow runs, a called reusable workflow's jobs under that workflow's file name, at any
 * depth. A call this cannot follow fails the test rather than hide the jobs behind it.
 */
function jobsOf(file: string): Job[] {
	return Object.entries(parse(file).jobs).flatMap(([job, j]) => {
		if (j.uses === undefined) return [{ key: `${file} ${job}`, steps: j.steps ?? [] }]
		const called = j.uses.match(/^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/)?.[1]
		if (!called) throw new Error(`${file} ${job}: cannot follow the reusable workflow ${j.uses}`)
		return jobsOf(called)
	})
}

test("test:unfetched runs every run step of each job Quality and Web run without the checkout, or names why not", () => {
	const unfetched = ["pr-quick.yml", "web.yml"].flatMap(jobsOf).filter((j) => !j.steps.some((s) => s.uses?.includes("ppv2-fetch")))
	expect(unfetched.map((j) => j.key).sort()).toEqual([...JOBS.map((j) => `${j.workflow} ${j.job}`), ...Object.keys(LEFT_OUT)].sort())
	for (const { workflow: file, job } of JOBS) {
		const steps = parse(file).jobs[job]?.steps ?? []
		expect(stepsOf(workflow(file), job).map((s): string | undefined => s.run)).toEqual(
			steps.filter((s) => s.uses === undefined).map((s) => s.run),
		)
	}
})

test("steps run as the runner runs them, and a step only a runner can evaluate fails by name", () => {
	const job = (step: string, defaults = "") => `jobs:\n  j:\n${defaults}    steps:\n      - uses: ./.github/actions/setup-bun\n${step}`
	expect(stepsOf(job("      - name: ok\n        if: always()\n        run: bun run lint\n"), "j", "/r")).toEqual([
		{ name: "j → ok", shell: ["bash", "-e"], run: "bun run lint", env: {}, cwd: "/r", mayFail: false },
	])
	const [explicit] = stepsOf(
		job("      - shell: bash\n        continue-on-error: true\n        working-directory: /abs\n        run: x\n"),
		"j",
		"/r",
	)
	expect(explicit).toMatchObject({ shell: ["bash", "--noprofile", "--norc", "-eo", "pipefail"], cwd: "/abs", mayFail: true })
	const refused: [string, RegExp, string?][] = [
		["      - name: ref\n        run: echo ${{ github.ref }}\n", /j → ref: run holds an expression/],
		["      - name: sha\n        env:\n          SHA: ${{ github.sha }}\n        run: echo\n", /j → sha: env SHA holds an expression/],
		["      - name: pr\n        if: github.event_name == 'pull_request'\n        run: echo\n", /j → pr: if: .* is a condition/],
		["      - name: dir\n        working-directory: ${{ inputs.dir }}\n        run: echo\n", /j → dir: working-directory/],
		["      - name: soft\n        continue-on-error: ${{ inputs.soft }}\n        run: echo\n", /j → soft: continue-on-error/],
		["      - name: map\n        env: ${{ fromJSON(vars.E) }}\n        run: echo\n", /j → map: env holds an expression/],
		["      - name: proto\n        shell: constructor\n        run: echo\n", /j → proto: shell constructor is not one/],
		["      - name: sh\n        run: echo\n", /j → sh: shell sh is not one/, "    defaults:\n      run:\n        shell: sh\n"],
	]
	for (const [step, error, defaults] of refused) expect(() => stepsOf(job(step, defaults), "j")).toThrow(error)
})

test("only a symlink is moved aside, and nothing is put back over a .ppv2 that appeared during the run", () => {
	const base = join(homedir(), ".cache", "pp", "unfetched")
	mkdirSync(base, { recursive: true })
	const dir = mkdtempSync(join(base, "test-"))
	try {
		const [link, hidden] = [join(dir, ".ppv2"), join(dir, ".ppv2.hidden")]
		const none = hideCheckout(dir)
		expect(none.moved).toBe(false)
		symlinkSync("/nonexistent/checkout/src", link)
		expect(() => none.restore()).toThrow(/appeared during the run/)
		const moved = hideCheckout(dir)
		expect(moved.moved).toBe(true)
		expect(() => lstatSync(link)).toThrow()
		expect(() => hideCheckout(dir)).toThrow(`If none is running: mv ${hidden} ${link}`)
		symlinkSync("/fetched/again", link)
		expect(() => moved.restore()).toThrow(`the original link is at ${hidden}`)
		expect(readlinkSync(link)).toBe("/fetched/again")
		expect(() => hideCheckout(dir)).toThrow(/both exist/)
		rmSync(link)
		moved.restore()
		expect(readlinkSync(link)).toBe("/nonexistent/checkout/src")
		rmSync(link)
		mkdirSync(link)
		expect(() => hideCheckout(dir)).toThrow(/is not a symlink/)
		expect(lstatSync(link).isDirectory()).toBe(true)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
