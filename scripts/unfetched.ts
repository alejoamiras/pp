/**
 * Runs the pull-request jobs that never fetch the Privacy Pools checkout (Quality's lint and
 * typecheck and unit jobs, Web's build job) with `#ppv2` unresolvable, as a hosted runner has it.
 * This worktree's `packages/pp-env/.ppv2` link is moved aside for the run and put back after, so a
 * process in the same worktree that loads `#ppv2` meanwhile fails; other worktrees are untouched.
 *
 *   bun run test:unfetched
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { killGroup, own, spawnWatched } from "@pp/run-isolation/process"

export const ROOT = join(import.meta.dir, "..")

/** The pull-request jobs that run no `ppv2-fetch`, by workflow file and job key. */
export const JOBS = [
	{ workflow: "_lint-and-typecheck.yml", job: "lint-and-typecheck" },
	{ workflow: "_unit-tests.yml", job: "unit-tests" },
	{ workflow: "web.yml", job: "build" },
] as const

export interface Step {
	name: string
	/** The runner's command line for the step's shell, before the script. */
	shell: readonly string[]
	run: string
	env: Record<string, string>
	cwd: string
	/** `continue-on-error: true`: a failure is reported but does not fail the job. */
	mayFail: boolean
}

type RawStep = { name?: string; uses?: string; run?: unknown; if?: unknown; shell?: unknown } & Record<string, unknown>
type RawDefaults = { run?: { shell?: string; "working-directory"?: string } }
type RawJob = { steps?: RawStep[]; env?: Record<string, unknown>; defaults?: RawDefaults }
type RawWorkflow = { env?: Record<string, unknown>; defaults?: RawDefaults; jobs?: Record<string, RawJob> }

/** How the runner invokes each shell this script can mirror: an unset shell is `bash -e`, without pipefail. */
const SHELLS: Record<string, readonly string[]> = {
	"": ["bash", "-e"],
	bash: ["bash", "--noprofile", "--norc", "-eo", "pipefail"],
}
const EXPRESSION = "${{"
const runnerOnly = (where: string, what: string) => new Error(`${where}: ${what} only a runner can evaluate`)

function plainEnv(env: unknown, where: string): Record<string, string> {
	if (env === undefined) return {}
	// A whole map can be one expression (`env: ${{ fromJSON(...) }}`).
	if (typeof env !== "object" || env === null) throw runnerOnly(where, "env holds an expression")
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (String(value).includes(EXPRESSION)) throw runnerOnly(where, `env ${key} holds an expression`)
		out[key] = String(value)
	}
	return out
}

interface JobContext {
	env: Record<string, string>
	shell: string | undefined
	dir: string | undefined
	root: string
}

/** One `run:` step as a local command; `if: always()` is allowed because every step runs here. */
function localStep(s: RawStep, where: string, job: JobContext): Step {
	if (typeof s.run !== "string") throw new Error(`${where}: neither run nor uses`)
	if (s.if !== undefined && String(s.if).trim() !== "always()") throw runnerOnly(where, `if: ${String(s.if)} is a condition`)
	const env = { ...job.env, ...plainEnv(s.env, where) }
	for (const [key, value] of Object.entries(s))
		if (key !== "name" && key !== "env" && JSON.stringify(value).includes(EXPRESSION))
			throw runnerOnly(where, `${key} holds an expression`)
	const shellName = String(s.shell ?? job.shell ?? "")
	const shell = Object.hasOwn(SHELLS, shellName) ? SHELLS[shellName] : undefined
	if (!shell) throw new Error(`${where}: shell ${shellName} is not one this script mirrors`)
	const dir = (s["working-directory"] as string | undefined) ?? job.dir
	if (dir?.includes(EXPRESSION)) throw runnerOnly(where, "working-directory holds an expression")
	return { name: where, shell, run: s.run, env, cwd: dir ? resolve(job.root, dir) : job.root, mayFail: s["continue-on-error"] === true }
}

/**
 * A job's `run:` steps in order, skipping `uses:` steps. Throws, naming the step, on any part a
 * runner must evaluate: an expression anywhere but its name, an `if:` other than `always()`, or a
 * shell other than the runner's default and `bash`.
 */
export function stepsOf(workflowText: string, job: string, root = ROOT): Step[] {
	const wf = Bun.YAML.parse(workflowText) as RawWorkflow
	const j = wf.jobs?.[job]
	if (!j?.steps) throw new Error(`no job ${job} with steps`)
	const context: JobContext = {
		env: { ...plainEnv(wf.env, `${job}: workflow env`), ...plainEnv(j.env, `${job}: job env`) },
		shell: j.defaults?.run?.shell ?? wf.defaults?.run?.shell,
		dir: j.defaults?.run?.["working-directory"] ?? wf.defaults?.run?.["working-directory"],
		root,
	}
	return j.steps.flatMap((s, i) => (s.uses === undefined ? [localStep(s, `${job} → ${s.name ?? `step ${i + 1}`}`, context)] : []))
}

type Kind = "none" | "symlink" | "other"
function kind(path: string): Kind {
	try {
		return lstatSync(path).isSymbolicLink() ? "symlink" : "other"
	} catch {
		return "none"
	}
}

export interface Hidden {
	/** Whether a link was moved aside; false when the worktree had none. */
	moved: boolean
	/** Puts a moved link back. Throws, leaving the moved link where it is, if `.ppv2` appeared meanwhile. */
	restore(): void
}

/**
 * Moves `<pkgDir>/.ppv2` aside. Refuses anything but a symlink, and a link already moved aside (a run
 * in progress, or one that died). The link is read before the moved-aside name, so a run starting
 * while another moves the link sees the moved one and refuses.
 */
export function hideCheckout(pkgDir: string): Hidden {
	const link = join(pkgDir, ".ppv2")
	const hidden = join(pkgDir, ".ppv2.hidden")
	const linkKind = kind(link)
	if (linkKind === "other") throw new Error(`${link} is not a symlink; refusing to move it`)
	if (kind(hidden) !== "none")
		throw new Error(
			linkKind === "none"
				? `${hidden} exists: a run is in progress here, or one died. If none is running: mv ${hidden} ${link}`
				: `${link} and ${hidden} both exist: a run is in progress here, or one died and .ppv2 was fetched again. If none is running, keep one of them.`,
		)
	const moved = linkKind === "symlink"
	if (moved) renameSync(link, hidden)
	let done = false
	return {
		moved,
		restore() {
			if (done) return
			const appeared = new Error(
				`${link} appeared during the run, so the run did not see what CI sees${moved ? `; the original link is at ${hidden}` : ""}`,
			)
			if (moved) {
				// symlink, unlike rename, fails rather than replace a .ppv2 that appeared.
				try {
					symlinkSync(readlinkSync(hidden), link)
				} catch (e) {
					throw (e as NodeJS.ErrnoException).code === "EEXIST" ? appeared : e
				}
				unlinkSync(hidden)
			} else if (kind(link) !== "none") throw appeared
			done = true
		},
	}
}

/** The caller's environment without the startup files it would make bash run, then the step's own. */
function stepEnv(step: Step, runDir: string): NodeJS.ProcessEnv {
	const inherited: NodeJS.ProcessEnv = { ...process.env }
	delete inherited.BASH_ENV
	delete inherited.ENV
	return { ...inherited, ...step.env, RUNNER_TEMP: runDir, GITHUB_STEP_SUMMARY: join(runDir, "summary.md") }
}

/**
 * Runs one step in a watched process group; whatever the step left running in its group is ended
 * before the next step starts. `leaked` is a member that outlived SIGKILL.
 */
async function runStep(step: Step, runDir: string): Promise<{ code: number; leaked: boolean }> {
	// spawnWatched takes no cwd; the step's directory is entered inside its own shell.
	const script = `cd -- '${step.cwd.replaceAll("'", `'\\''`)}'\n${step.run}`
	const [cmd = "bash", ...flags] = step.shell
	const owned = own(spawnWatched(cmd, [...flags, "-c", script], { stdio: ["ignore", "inherit", "inherit"], env: stepEnv(step, runDir) }))
	await owned.exited
	const leaked = !(await killGroup(owned))
	return { code: owned.child.exitCode ?? (owned.child.signalCode ? 128 : 127), leaked }
}

async function runAll(steps: Step[], runDir: string): Promise<string[]> {
	const failed: string[] = []
	for (const step of steps) {
		console.log(`[unfetched] ${step.name}`)
		const { code, leaked } = await runStep(step, runDir)
		if (leaked) failed.push(`${step.name} (left a process that outlived SIGKILL)`)
		else if (code !== 0 && step.mayFail) console.log(`[unfetched] ${step.name} failed (exit ${code}), allowed by continue-on-error`)
		else if (code !== 0) failed.push(step.name)
	}
	return failed
}

async function main(): Promise<number> {
	const steps = JOBS.flatMap(({ workflow, job }) => stepsOf(readFileSync(join(ROOT, ".github/workflows", workflow), "utf8"), job))
	let runDir: string | undefined
	let hidden: Hidden | undefined
	let restoreError: unknown
	const finish = () => {
		try {
			hidden?.restore()
		} catch (e) {
			restoreError ??= e
		}
		try {
			if (runDir) rmSync(runDir, { recursive: true, force: true })
		} catch (e) {
			console.error(`[unfetched] could not remove ${runDir}: ${e instanceof Error ? e.message : String(e)}`)
		}
		if (restoreError) console.error(`[unfetched] ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
	}
	// Registered before anything is created. Each step's group ends with this process however it dies.
	for (const [signal, code] of [
		["SIGHUP", 129],
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)
		process.once(signal, () => {
			finish()
			process.exit(code)
		})
	let failed: string[]
	try {
		const parent = join(homedir(), ".cache", "pp", "unfetched")
		mkdirSync(parent, { recursive: true })
		runDir = mkdtempSync(join(parent, "run-"))
		hidden = hideCheckout(join(ROOT, "packages/pp-env"))
		if (!hidden.moved) console.log("[unfetched] no packages/pp-env/.ppv2: this worktree is already unfetched")
		failed = await runAll(steps, runDir)
	} finally {
		finish()
	}
	if (restoreError) return 1
	if (failed.length === 0) {
		console.log(`[unfetched] all ${steps.length} steps passed without the checkout`)
		return 0
	}
	console.error(`[unfetched] ${failed.length} of ${steps.length} steps failed without the checkout:\n  ${failed.join("\n  ")}`)
	return 1
}

if (import.meta.main) process.exit(await main())
