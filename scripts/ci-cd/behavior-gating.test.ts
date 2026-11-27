/**
 * Anti-drift guard for the CI paths-filter gates. Each gate's target graph is recomputed from the
 * workspace manifests and the live filter must still cover it, so a new `@pp/*` dependency
 * added without gating it, or a `!` negation (dorny's some-quantifier footgun), fails here. The
 * npm packages the workspaces import sit outside that graph: a bump moves `bun.lock`, which every
 * gate covers. The unit-test workflow runs this file on every PR; the last test pins that.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
// Deployable leaves live under apps/, libraries under packages/.
const APPS = new Set<string>(["web"])
const dirOf = (pkg: string): string => (APPS.has(pkg) ? "apps" : "packages")

/** Direct `@pp/*` workspace deps of a package (runtime + dev — what it's built/tested from). */
function directDeps(pkg: string): string[] {
	const p = JSON.parse(readFileSync(join(ROOT, dirOf(pkg), pkg, "package.json"), "utf8"))
	return Object.keys({ ...p.dependencies, ...p.devDependencies })
		.filter((k) => k.startsWith("@pp/"))
		.map((k) => k.slice("@pp/".length))
}

/** Transitive `@pp/*` dependency closure of a target (EXCLUDING the target itself). */
function transitiveDeps(target: string): string[] {
	const seen = new Set<string>()
	const walk = (pkg: string) => {
		for (const d of directDeps(pkg))
			if (!seen.has(d)) {
				seen.add(d)
				walk(d)
			}
	}
	walk(target)
	return [...seen].sort()
}

/** Parse a workflow's dorny `changes` filters — TWO-LEVEL (workflow YAML → the `with.filters` string), never regex. */
function filtersOf(workflow: string): Record<string, string[]> {
	// biome-ignore lint/suspicious/noExplicitAny: parsed-YAML shape is dynamic.
	const wf = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", workflow), "utf8")) as any
	for (const job of Object.values(wf.jobs)) {
		// biome-ignore lint/suspicious/noExplicitAny: parsed-YAML shape is dynamic.
		for (const step of (job as any).steps ?? []) {
			if (typeof step.uses === "string" && step.uses.includes("dorny/paths-filter") && step.with?.filters) {
				return Bun.YAML.parse(step.with.filters) as Record<string, string[]>
			}
		}
	}
	throw new Error(`no dorny/paths-filter step found in ${workflow}`)
}

const manifestOf = (pkg: string) => JSON.parse(readFileSync(join(ROOT, dirOf(pkg), pkg, "package.json"), "utf8"))
const exportTargets = (e: unknown): string[] => (typeof e === "string" ? [e] : Object.values(e ?? {}).flatMap(exportTargets))
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/
const INSTALLED = /(^|\/)(node_modules|dist)\//

/**
 * Files a change can touch: tracked, or untracked and not ignored. A filter only ever matches changed
 * tracked files, and an ignored tree (a local browser run's state, build output) can hold thousands.
 */
function listWalkable(root = ROOT): string[] {
	// The ceiling keeps git from taking an enclosing repository for one at `root`.
	const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) }
	const ls = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, env })
	if (!ls.success) throw new Error(`git ls-files exited ${ls.exitCode}: ${ls.stderr.toString().trim()}`)
	return ls.stdout
		.toString()
		.split("\0")
		.filter((f) => f && !INSTALLED.test(f) && existsSync(join(root, f)))
}
let walkable: string[] | undefined

/** Every walkable file under a repo-relative directory. */
function filesUnder(dir: string, files: readonly string[] = (walkable ??= listWalkable())): string[] {
	return files.filter((f) => f.startsWith(`${dir}/`))
}

/** The repo file a specifier names, trying TypeScript's extension and index rules. */
function resolveFile(base: string): string | undefined {
	const stem = base.replace(/\.js$/, "")
	return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, "index.ts")].find(
		(c) => !INSTALLED.test(c) && existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile(),
	)
}

/** A workspace's entry files for a subpath: its export targets, or, without `exports`, every file it holds. */
function entriesOf(pkg: string, sub: string | undefined): string[] {
	const dir = `${dirOf(pkg)}/${pkg}`
	const exports = manifestOf(pkg).exports
	if (exports === undefined) return filesUnder(dir)
	const hit = sub === undefined || typeof exports === "string" ? undefined : exports[`.${sub}`]
	return exportTargets(hit ?? exports).map((t) => join(dir, t))
}

const RUNS_IN = /\bbun run --cwd[= ]["']?(?:\$\{?\w+\}?\/)?packages\/([\w-]+)["']?(?:[ \t]+([\w:.-]+))?/g

/**
 * Every file a package can load, transitively: relative imports, `@pp/*` imports through the named
 * workspace's exports (Bun's own import scan; type-only imports load nothing), and the files a
 * `bun run --cwd packages/<x> <script>` in a script or manifest names (all of `<x>` when the script is
 * not one of its own); taking all of `<x>` for a named script would pull its tests and test config into
 * a runner's filter. A declared `@pp/*` dependency nothing imports by name counts through all its
 * entries. npm packages sit outside: a bump moves bun.lock, which every gate covers.
 */
function reachedFiles(target: string): { files: Set<string>; packages: Set<string> } {
	const files = new Set<string>()
	const packages = new Set<string>()
	const named = new Set<string>()
	const queue = filesUnder(`${dirOf(target)}/${target}`)
	const add = (f: string) => {
		if (files.has(f)) return
		files.add(f)
		queue.push(f)
	}
	const enter = (pkg: string, entries: string[]) => {
		packages.add(pkg)
		for (const f of entries) add(f)
	}
	// Reach stops here: spawned binaries, computed dynamic imports and reads of another package's files by path are not followed.
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		for (const [pkg, script] of runsNamedIn(file)) enter(pkg, scriptFiles(pkg, script))
		if (!SOURCE.test(file)) continue
		const { local, workspaces } = importsOf(file)
		for (const f of local) add(f)
		for (const [pkg, sub] of workspaces) {
			named.add(pkg)
			enter(pkg, entriesOf(pkg, sub))
		}
	}
	for (const pkg of transitiveDeps(target)) if (!named.has(pkg)) enter(pkg, entriesOf(pkg, undefined))
	return { files, packages }
}

const isWorkspace = (pkg: string) => existsSync(join(ROOT, dirOf(pkg), pkg, "package.json"))

/** The workspaces, with an optional script, that a script, manifest or source file runs with `bun run --cwd`. */
function runsNamedIn(file: string): [string, string | undefined][] {
	if (!/(\.sh|\/package\.json)$/.test(file) && !SOURCE.test(file)) return []
	return [...readFileSync(join(ROOT, file), "utf8").matchAll(RUNS_IN)]
		.filter(([, pkg]) => pkg !== undefined && isWorkspace(pkg))
		.map(([, pkg, script]) => [pkg as string, script])
}

/** The files a workspace script loads: those its command names, or all of the package when the script is not one of its own. */
function scriptFiles(pkg: string, script: string | undefined): string[] {
	const dir = `${dirOf(pkg)}/${pkg}`
	const command = manifestOf(pkg).scripts?.[script ?? ""]
	if (typeof command !== "string") return filesUnder(dir)
	return [...command.matchAll(/[\w./-]+\.(?:ts|mts|js|mjs|sh)\b/g)].flatMap(([token]) => resolveFile(join(dir, token)) ?? [])
}

/** A source file's imports: the repo files its relative specifiers name, and the workspaces its `@pp/*` specifiers name, with subpath. */
function importsOf(file: string): { local: string[]; workspaces: [string, string][] } {
	const local: string[] = []
	const workspaces: [string, string][] = []
	const loader = file.endsWith(".tsx") ? "tsx" : /\.m?js$/.test(file) ? "js" : "ts"
	// The scan rejects a shebang line.
	const code = readFileSync(join(ROOT, file), "utf8").replace(/^#!.*/, "")
	for (const { path: spec } of new Bun.Transpiler({ loader }).scanImports(code)) {
		if (spec.startsWith(".")) {
			const hit = resolveFile(join(dirname(file), spec))
			if (hit) local.push(hit)
			continue
		}
		const [, pkg, rest] = /^@pp\/([\w-]+)(\/.*)?$/.exec(spec) ?? []
		if (pkg && isWorkspace(pkg)) workspaces.push([pkg, rest ?? ""])
	}
	return { local, workspaces }
}

/**
 * For every package a filter gates whole (`packages/<x>/**`), the files it can load, and the manifests
 * of the workspaces it reaches, that the filter leaves out.
 */
function closureGaps(patterns: string[]): string[] {
	const gated = (path: string) => patterns.some((p) => new Bun.Glob(p).match(path))
	const gaps = new Set<string>()
	const targets = patterns.map((p) => /^(?:packages|apps)\/([^/]+)\/\*\*$/.exec(p)?.[1]).filter((x): x is string => Boolean(x))
	for (const target of targets) {
		const { files, packages } = reachedFiles(target)
		for (const pkg of packages) files.add(`${dirOf(pkg)}/${pkg}/package.json`)
		for (const f of files) if (!gated(f)) gaps.add(f)
	}
	return [...gaps].sort()
}

/** Filters whose verdict a job of the workflow reads through the changes job's outputs of a paths-filter step. */
function readFilters(file: string): string[] {
	const wf = workflow(file)
	const outputs: Record<string, string> = wf.jobs.changes?.outputs ?? {}
	const filterSteps = new Set(
		// biome-ignore lint/suspicious/noExplicitAny: parsed-YAML shape is dynamic.
		(wf.jobs.changes?.steps ?? []).filter((s: any) => String(s.uses).includes("dorny/paths-filter")).map((s: any) => s.id),
	)
	const jobs = Object.entries(wf.jobs as Record<string, unknown>).filter(([name]) => name !== "changes")
	const outs = jobs.flatMap(([, job]) => [...JSON.stringify(job).matchAll(/needs\.changes\.outputs\.([\w-]+)/g)].map((m) => m[1] ?? ""))
	const read = outs
		.flatMap((out) => [...(outputs[out] ?? "").matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)])
		.filter(([, step]) => filterSteps.has(step))
		.map(([, , filter]) => filter ?? "")
	return [...new Set(read)]
}

const FILTER_WORKFLOWS = [
	"pr-quick.yml",
	"bridge-contracts.yml",
	"actionlint.yml",
	"pp-env.yml",
	"local-stack.yml",
	"pool-client.yml",
	"web.yml",
]

/**
 * The check-run each PR workflow's aggregator job produces. Branch protection matches these by
 * name, so a renamed job that is not repointed there blocks every merge; this pin fails first.
 */
const AGGREGATOR_CHECKS: Record<string, string> = {
	"pr-quick.yml": "quality-status",
	"bridge-contracts.yml": "bridge-contracts-status",
	"actionlint.yml": "actionlint-status",
	"pp-env.yml": "pp-env-status",
	"local-stack.yml": "local-stack-status",
	"pool-client.yml": "pool-client-status",
	"web.yml": "web-status",
}

// biome-ignore lint/suspicious/noExplicitAny: parsed-YAML shape is dynamic.
const workflow = (file: string): any => Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8"))

type Step = { id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
const actionSteps = (action: string): Step[] =>
	Bun.YAML.parse(readFileSync(join(ROOT, ".github/actions", action, "action.yml"), "utf8")).runs.steps

/**
 * The actions a composite action calls: through a nested `uses: ./.github/actions/<name>`, or by
 * running `$GITHUB_ACTION_PATH/../<name>/<file>`, the one spelling of a sibling's path it may use.
 */
function actionsRunBy(action: string): string[] {
	const text = readFileSync(join(ROOT, ".github/actions", action, "action.yml"), "utf8")
	const runs = (text.match(/(?:GITHUB_ACTION_PATH|action_path)\S*/g) ?? []).flatMap((ref) => {
		if (!ref.includes("..")) return []
		const name = /^GITHUB_ACTION_PATH\/\.\.\/([\w-]+)\/[\w.-]+"?$/.exec(ref)?.[1]
		if (name === undefined) throw new Error(`${action}: ${ref} is not $GITHUB_ACTION_PATH/../<action>/<file>`)
		return [name]
	})
	const uses = actionSteps(action).flatMap((step) => step.uses?.match(/^\.\/\.github\/actions\/([\w-]+)$/)?.[1] ?? [])
	return [...new Set([...runs, ...uses])]
}

type Job = { if?: string; uses?: string; needs?: string | string[]; steps?: Step[] }
const LOCAL_ACTION = /^\.\/\.github\/actions\/([\w-]+)$/
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/([\w.-]+)$/

/** Every local action a job runs: its steps', a called workflow's jobs', and what each of those runs in turn. */
function actionsOfJob(job: Job, found = new Set<string>()): Set<string> {
	const visit = (action: string): void => {
		if (found.has(action)) return
		found.add(action)
		for (const dep of actionsRunBy(action)) visit(dep)
	}
	if (job.uses !== undefined) {
		const called = LOCAL_WORKFLOW.exec(job.uses)?.[1]
		if (called === undefined) throw new Error(`a job calls ${job.uses}, not ./.github/workflows/<file>`)
		for (const inner of Object.values(workflow(called).jobs) as Job[]) actionsOfJob(inner, found)
		return found
	}
	for (const uses of (job.steps ?? []).flatMap((s) => (s.uses?.startsWith("./") ? [s.uses] : []))) {
		const action = LOCAL_ACTION.exec(uses)?.[1]
		if (action === undefined) throw new Error(`a step uses ${uses}, not ./.github/actions/<name>`)
		visit(action)
	}
	return found
}

/**
 * The paths-filter keys whose verdict a job's `if` reads through the changes job's outputs, directly
 * or through one step that combines filter outputs in its `env`.
 */
function filterKeysOf(wf: { jobs: Record<string, { outputs?: Record<string, string>; steps?: Step[] }> }, job: Job): string[] {
	const changes = wf.jobs.changes
	const steps = changes?.steps ?? []
	const filterIds = new Set(steps.filter((s) => s.uses?.includes("dorny/paths-filter")).map((s) => s.id))
	const refs = (text: string) => [...text.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)]
	const direct = (text: string) => refs(text).flatMap(([, id, key]) => (filterIds.has(id) ? [key ?? ""] : []))
	const viaStep = (id: string) => direct(JSON.stringify(steps.find((s) => s.id === id)?.env ?? {}))
	const keysOf = (text: string) => refs(text).flatMap(([, id = "", key = ""]) => (filterIds.has(id) ? [key] : viaStep(id)))
	const outs = [...(job.if ?? "").matchAll(/needs\.changes\.outputs\.([\w-]+)/g)].map((m) => m[1] ?? "")
	return [...new Set(outs.flatMap((out) => keysOf(changes?.outputs?.[out] ?? "")))]
}

/**
 * Each job of a PR workflow that runs a local action is gated by filters that cover every file of
 * that action. A job with no gate of its own may not wait on a gated one, whose gate it would
 * inherit unchecked. Returns how many jobs it checked.
 */
function expectJobsCoverTheirActions(file: string): number {
	const wf = workflow(file)
	const filters = filtersOf(file)
	const jobs = Object.entries(wf.jobs) as [string, Job][]
	const gatedJobs = new Set(jobs.filter(([, j]) => /needs\.changes\.outputs/.test(j.if ?? "")).map(([name]) => name))
	let checked = 0
	for (const [name, job] of jobs) {
		const files = [...actionsOfJob(job)].flatMap((a) => filesUnder(`.github/actions/${a}`))
		if (name === "changes" || files.length === 0) continue
		if (!gatedJobs.has(name)) {
			expect(
				[job.needs ?? []].flat().filter((n) => gatedJobs.has(n)),
				`${file} ${name}: give it its own gate`,
			).toEqual([])
			continue
		}
		const keys = filterKeysOf(wf, job)
		expect(keys.length, `${file} ${name}: its if reads no filter`).toBeGreaterThan(0)
		const covered = (path: string) => keys.some((k) => (filters[k] ?? []).some((p) => new Bun.Glob(p).match(path)))
		for (const path of files) expect(covered(path), `${file} ${name} runs ${path}`).toBe(true)
		checked++
	}
	return checked
}

/** Files outside a package that its shipped source imports by relative path, repo-relative. */
function importsOutside(pkg: string): string[] {
	const src = join(ROOT, "packages", pkg, "src")
	const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
	return files.flatMap((file) =>
		[...readFileSync(join(src, file), "utf8").matchAll(/from "(\.\.\/[^"]+)"/g)]
			.map((m) => relative(ROOT, join(src, dirname(file), m[1])))
			.filter((path) => !path.startsWith(`packages/${pkg}/`)),
	)
}

describe("CI aggregator check names", () => {
	test("each PR workflow's status job produces its documented check-run name", () => {
		for (const [file, name] of Object.entries(AGGREGATOR_CHECKS)) {
			const wf = workflow(file)
			expect(wf.jobs.status?.name, `${file}: jobs.status.name`).toBe(name)
			expect(wf.jobs.status?.if, `${file}: the aggregator must always run`).toBe("always()")
		}
	})

	// A job in `needs` whose result the aggregator never reads can be red under a green check.
	test("each aggregator reads the result of exactly the jobs it waits on", () => {
		for (const file of Object.keys(AGGREGATOR_CHECKS)) {
			const status = workflow(file).jobs.status
			const read = [...JSON.stringify(status.steps).matchAll(/needs\.([\w-]+)\.result/g)].map((m) => m[1])
			expect([...new Set(read)].sort(), file).toEqual([...status.needs].sort())
		}
	})

	test("the protection runbook renames onto exactly these names", async () => {
		const { RENAMES } = await import("./required-checks")
		for (const target of Object.values(RENAMES)) {
			expect(Object.values(AGGREGATOR_CHECKS), `rename target '${target}' must be a produced check`).toContain(target)
		}
	})
})

describe("CI behavior-gating guard", () => {
	test("a per-package workflow gates its package whole in a filter its jobs read", () => {
		const named = FILTER_WORKFLOWS.map((wf) => wf.replace(/\.yml$/, "")).filter((name) =>
			existsSync(join(ROOT, "packages", name, "package.json")),
		)
		expect(named.length).toBeGreaterThan(0)
		for (const name of named) {
			const filters = filtersOf(`${name}.yml`)
			// A manual-dispatch override output (`full`) is not a filter, even when a filter takes its name.
			expect(Object.keys(filters), `${name}.yml`).toEqual(expect.arrayContaining(readFilters(`${name}.yml`)))
			const read = readFilters(`${name}.yml`).flatMap((f) => filters[f] ?? [])
			expect(read, `${name}.yml`).toContain(`packages/${name}/**`)
		}
	})

	test("every filter that gates a package whole gates every file that package can load", () => {
		const gaps: Record<string, string[]> = {}
		for (const wf of FILTER_WORKFLOWS)
			for (const [name, patterns] of Object.entries(filtersOf(wf))) {
				const left = closureGaps(patterns)
				if (left.length > 0) gaps[`${wf} → ${name}`] = left
			}
		expect(gaps).toEqual({})
	})

	test("the closure pin names what a filter leaves out", () => {
		const stack = filtersOf("local-stack.yml")["stack"]
		const without = (drop: (p: string) => boolean) => closureGaps(stack.filter((p) => !drop(p)))
		const spec = without((p) => p.startsWith("packages/bridge-spec/"))
		expect(spec).toContain("packages/bridge-spec/package.json")
		expect(spec, "bridge-core imports @pp/bridge-spec/claim-secret").toContain("packages/bridge-spec/src/claim-secret.ts")
		expect(
			spec.every((f) => f.startsWith("packages/bridge-spec/")),
			spec.join(", "),
		).toBe(true)
		const core = without((p) => p === "packages/bridge-core/**")
		expect(core).toContain("packages/bridge-core/scripts/sandbox/index.ts")
		expect(core).toContain("packages/bridge-core/src/artifacts.ts")
		expect(without((p) => p.startsWith("contracts/"))).toContain(
			"contracts/bridge/aztec/token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json",
		)
		// A package without `exports` counts whole however it is named, and `bun run --cwd` reaches what its script runs.
		expect(entriesOf("e2e-kit", "/fixtures/egress")).toContain("packages/e2e-kit/fixtures/build-artifacts/handle.json")
		expect(closureGaps(["packages/e2e-kit/**"])).toContain("packages/bridge-core/scripts/sandbox/cli.ts")
		// An ignored file is never read, however much a local run leaves there. The probe goes through the
		// default inventory and imports a source file e2e-kit does not reach without it, found from the walk
		// itself: which files those are depends on the branch's dependency graph.
		walkable = undefined
		const reached = reachedFiles("e2e-kit").files
		const unreached = filesUnder("packages").find((f) => SOURCE.test(f) && !f.startsWith("packages/e2e-kit/") && !reached.has(f))
		if (unreached === undefined) throw new Error("every package source file is in e2e-kit's reach; the probe has nothing to import")
		const state = join(ROOT, "packages/e2e-kit/.e2e-state")
		mkdirSync(state, { recursive: true })
		const probes = mkdtempSync(join(state, "walk-probe-"))
		try {
			const ignored = relative(ROOT, join(probes, "probe.ts"))
			const spec = relative(dirname(ignored), unreached)
			writeFileSync(join(ROOT, ignored), `import ${JSON.stringify(spec)}\n`)
			expect(resolveFile(join(dirname(ignored), spec)), "the probe imports a file e2e-kit never reaches").toBe(unreached)
			walkable = undefined
			expect(reachedFiles("e2e-kit").files).not.toContain(unreached)
		} finally {
			walkable = undefined
			rmSync(probes, { recursive: true, force: true })
		}
		// An untracked file that is not ignored is listed before it is committed. It gets a repository of its
		// own, inside this checkout's ignored state: an untracked probe in the checkout could be listed by
		// another run walking it and be gone when read.
		const repo = mkdtempSync(join(state, "walk-repo-"))
		try {
			expect(() => listWalkable(repo), "a directory inside a repository is not one").toThrow(/git ls-files exited 128/)
			expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).success).toBe(true)
			mkdirSync(join(repo, "ignored"))
			writeFileSync(join(repo, ".gitignore"), "ignored/\n")
			for (const f of ["untracked.ts", "ignored/probe.ts"]) writeFileSync(join(repo, f), "")
			expect(listWalkable(repo).sort()).toEqual([".gitignore", "untracked.ts"])
		} finally {
			rmSync(repo, { recursive: true, force: true })
		}
		// A glob that names the directory but matches no file in it.
		expect(
			closureGaps([...stack.filter((p) => p !== "packages/run-isolation/src/**"), "packages/run-isolation/src/*/**/*.ts"]),
		).toContain("packages/run-isolation/src/process-group.ts")
	})

	test("NO `!` negation patterns anywhere (the dorny some-quantifier footgun)", () => {
		for (const wf of FILTER_WORKFLOWS) {
			for (const [name, pats] of Object.entries(filtersOf(wf))) {
				for (const p of pats) {
					expect(p.startsWith("!"), `${wf} → filter '${name}' has a forbidden negation: ${p}`).toBe(false)
				}
			}
		}
	})

	test("every filter pattern names a path that exists", () => {
		for (const wf of FILTER_WORKFLOWS) {
			for (const [name, pats] of Object.entries(filtersOf(wf))) {
				for (const pattern of pats) {
					const fixed = pattern.split("*")[0].replace(/\/$/, "")
					expect(existsSync(join(ROOT, fixed)), `${wf} → ${name}: ${pattern}`).toBe(true)
				}
			}
		}
	})

	test("the PR workflows filter no base branch, and only their changes jobs read pull requests", () => {
		for (const file of FILTER_WORKFLOWS) {
			const wf = workflow(file)
			expect(wf.on.pull_request?.branches, `${file}: a base filter starves stacked PRs of CI`).toBeUndefined()
			expect(wf.permissions, file).toEqual({ contents: "read" })
			for (const [name, job] of Object.entries(wf.jobs) as [string, { permissions?: unknown }][]) {
				const want = name === "changes" ? { contents: "read", "pull-requests": "read" } : undefined
				expect(job.permissions, `${file} → ${name}`).toEqual(want)
			}
		}
	})

	test("the e2e kit build covers the kit and the files bridge-core bundles", () => {
		const kit = filtersOf("pr-quick.yml")["kit"]
		expect(kit).toContain("packages/e2e-kit/**")
		const outside = importsOutside("bridge-core")
		expect(outside.length, "bridge-core bundles the hub, registry and token artifacts from contracts/").toBeGreaterThan(0)
		for (const path of outside) {
			expect(
				kit.some((pattern) => new Bun.Glob(pattern).match(path)),
				`kit must gate ${path}`,
			).toBe(true)
		}
		const wf = workflow("pr-quick.yml")
		expect(wf.jobs.changes.outputs["needs-kit-build"]).toBe("${{ steps.compute.outputs.needs-kit-build }}")
		expect(wf.jobs["build-e2e-kit"].if).toBe("needs.changes.outputs.needs-kit-build == 'true'")
	})

	test("web covers the app graph, the sandbox it boots, the contracts that sandbox compiles, its actions and the root config", () => {
		const web = filtersOf("web.yml")["web"]
		// The closure test above holds this filter to every file the app can load; this pins that it gates the app whole.
		expect(web, "web gates the app whole").toContain("apps/web/**")
		expect(web, "the kit's runner boots @pp/bridge-core/sandbox, which lives in scripts/").toContain("packages/bridge-core/scripts/**")
		expect(web, "the sandbox compiles the bridge from source (sandbox/forge.ts)").toContain("contracts/bridge/**")
		for (const path of importsOutside("bridge-core")) {
			expect(
				web.some((pattern) => new Bun.Glob(pattern).match(path)),
				`web must gate ${path}`,
			).toBe(true)
		}
		for (const p of [
			"package.json",
			"bun.lock",
			"bunfig.toml",
			"vitest.base.ts",
			"patches/**",
			".github/workflows/web.yml",
			".github/actions/setup-aztec/**",
			".github/actions/setup-bun/**",
			".github/actions/setup-playwright/**",
		]) {
			expect(web, `web must gate ${p}`).toContain(p)
		}
		const wf = workflow("web.yml")
		expect(wf.jobs.changes.outputs.web).toBe("${{ steps.override.outputs.full || steps.filter.outputs.web }}")
		for (const job of ["build", "e2e"]) expect(wf.jobs[job].if, job).toBe("needs.changes.outputs.web == 'true'")
		expect(wf.jobs.status.needs, "web-status waits on exactly the gate's jobs").toEqual(["changes", "build", "e2e"])
		expect(wf.jobs.e2e.steps.map((step: { run?: string }) => step.run)).toContain("bun run --cwd apps/web e2e")
	})

	test("web pins every external action to a commit and never persists the checkout token", () => {
		for (const [name, job] of Object.entries(workflow("web.yml").jobs) as [
			string,
			{ steps?: { uses?: string; with?: Record<string, unknown> }[] },
		][]) {
			for (const step of job.steps ?? []) {
				if (typeof step.uses !== "string" || step.uses.startsWith("./")) continue
				expect(step.uses, `${name}: a tag or branch can move under the same name`).toMatch(
					/^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}$/,
				)
				if (step.uses.startsWith("actions/checkout@")) expect(step.with?.["persist-credentials"], `${name}: checkout`).toBe(false)
			}
		}
	})

	test("bridge-contracts covers the contracts, the harness package, its graph, and the shared vitest config", () => {
		const contracts = filtersOf("bridge-contracts.yml")["contracts"]
		expect(contracts, "the Solidity + Noir sources").toContain("contracts/bridge/**")
		for (const pkg of ["bridge-core", "labelled-token"]) expect(contracts, pkg).toContain(`packages/${pkg}/**`)
		for (const p of [
			"vitest.base.ts",
			"package.json",
			"bun.lock",
			"bunfig.toml",
			"patches/**",
			".github/actions/setup-aztec/**",
			".github/actions/setup-bun/**",
			".github/actions/setup-foundry/**",
		]) {
			expect(contracts, `bridge-contracts must gate ${p}`).toContain(p)
		}
	})

	// A job must re-run when anything it executes changes, including an action reached only through
	// another action's script or through a called workflow.
	test("each gated job's filters cover every file of every local action it runs", () => {
		expect(actionsRunBy("ppv2-fetch")).toEqual(["setup-foundry"])
		expect(actionsRunBy("bridge-evm-build")).toEqual(["setup-foundry"])
		const prWorkflows = readdirSync(join(ROOT, ".github/workflows")).filter(
			(f) => !f.startsWith("_") && "pull_request" in workflow(f).on,
		)
		const gated = prWorkflows.filter((f) => workflow(f).jobs.changes !== undefined)
		expect(gated.sort(), "every PR workflow with a changes job is listed").toEqual([...FILTER_WORKFLOWS].sort())
		expect(gated.reduce((n, file) => n + expectJobsCoverTheirActions(file), 0)).toBeGreaterThan(gated.length)
	})

	test("pp-env covers its package, its graph, the shared vitest config, and every action its suites job calls", () => {
		const ppEnv = filtersOf("pp-env.yml")["pp-env"]
		const calls: string[] = workflow("pp-env.yml")
			.jobs.suites.steps.map((step: { uses?: string }) => step.uses)
			.filter((uses: string | undefined) => uses?.startsWith("./.github/actions/"))
		expect(calls.length).toBeGreaterThan(0)
		for (const p of [
			...calls.map((c) => `${c.slice(2)}/**`),
			"vitest.base.ts",
			"package.json",
			"bun.lock",
			"bunfig.toml",
			"patches/**",
		]) {
			expect(ppEnv, `pp-env must gate ${p}`).toContain(p)
		}
		expect(workflow("pp-env.yml").jobs.suites.if).toBe("needs.changes.outputs.pp-env == 'true'")
	})

	// A job-level bound would also count setup and the pool fetch, which is cold on every run of a
	// pull request that changes the pin.
	test("local-stack bounds each integration suite on its step, under a 20 min job", () => {
		const stack = workflow("local-stack.yml").jobs.stack
		expect(stack["timeout-minutes"]).toBe(20)
		const step = stack.steps.find((s: { name?: string }) => s.name === "Integration suite")
		const map = /^\$\{\{ fromJSON\('(\{[^']+\})'\)\[matrix\.suite\] \|\| 20 \}\}$/.exec(step?.["timeout-minutes"])?.[1]
		expect(map, "the suite step's bound comes from a suite → minutes map").toBeDefined()
		const bounds: Record<string, number> = JSON.parse(map ?? "{}")
		const suites = readdirSync(join(ROOT, "packages/local-stack/test/integration"))
			.filter((f) => f.endsWith(".integration.test.ts"))
			.map((f) => f.slice(0, -".integration.test.ts".length))
			.sort()
		expect(Object.keys(bounds).sort()).toEqual(suites)
		for (const [suite, minutes] of Object.entries(bounds)) {
			expect(minutes, suite).toBeGreaterThanOrEqual(2)
			expect(minutes, suite).toBeLessThan(20)
		}
	})

	test("pool-client covers its package, pp-env whole, the shared test config, and every action its jobs call", () => {
		const poolClient = filtersOf("pool-client.yml")["pool-client"]
		const jobs = workflow("pool-client.yml").jobs
		const calls: string[] = [jobs.unit, jobs.suites]
			.flatMap((job: { steps: { uses?: string }[] }) => job.steps.map((step) => step.uses))
			.filter((uses: string | undefined) => uses?.startsWith("./.github/actions/"))
		expect(calls.length).toBeGreaterThan(0)
		// Its suites run pp-env's CLI and import pp-env's sources and fixtures by relative path;
		// setup-aztec reads the Aztec version from bridge-core's manifest.
		const roots = [
			"packages/pp-env/**",
			"packages/bridge-core/package.json",
			"vitest.base.ts",
			"package.json",
			"bun.lock",
			"bunfig.toml",
			"patches/**",
		]
		for (const p of [...calls.map((c) => `${c.slice(2)}/**`), ...roots]) {
			expect(poolClient, `pool-client must gate ${p}`).toContain(p)
		}
		for (const job of ["unit", "suites"]) expect(jobs[job].if, job).toBe("needs.changes.outputs.pool-client == 'true'")
	})
})

// A title on a public repo is written by whoever opens the PR: no write token, no secret, and the
// title reaches the script only through the environment.
test("commit-messages.yml runs on pull_request alone, re-judges every head and edit, title as data", () => {
	const wf = workflow("commit-messages.yml")
	expect(Object.keys(wf.on)).toEqual(["pull_request"])
	expect(wf.on.pull_request.types).toEqual(["opened", "edited", "reopened", "synchronize"])
	expect(wf.concurrency.group).toContain("github.event.pull_request.head.sha")
	expect(wf.permissions).toEqual({ contents: "read" })
	const job = wf.jobs["commit-messages"]
	expect(job.name).toBe("commit-messages-status")
	expect(job.permissions).toBeUndefined()
	type Step = { run?: string; env?: Record<string, string> }
	for (const step of job.steps as Step[]) expect(step.run ?? "").not.toContain("${{")
	const title = (job.steps as Step[]).find((s) => s.run === "bash scripts/ci-cd/lint-pr-title.sh")
	expect(title?.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}", PR_NUMBER: "${{ github.event.pull_request.number }}" })
	const commits = (job.steps as Step[]).find((s) => s.run?.startsWith("bash scripts/ci-cd/commitlint-own.sh"))
	expect(commits?.run).toBe('bash scripts/ci-cd/commitlint-own.sh "$HEAD_SHA" "$BASE_SHA" origin/main')
	expect(commits?.env).toEqual({
		BASE_SHA: "${{ github.event.pull_request.base.sha }}",
		HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
	})
})

// The excluded main needs every branch fetched, which fetch-depth 0 does.
test("Commitlint lints only the PR's own commits, excluding its base and main", () => {
	expect(workflow("commit-messages.yml").jobs["commit-messages"].steps[0].with["fetch-depth"]).toBe(0)
	const job = workflow("pr-quick.yml").jobs.commitlint
	expect(job.steps[0].with["fetch-depth"]).toBe(0)
	expect(job.steps.map((s: { run?: string }) => s.run)).toContain(
		'bash scripts/ci-cd/commitlint-own.sh "$HEAD_SHA" "$BASE_SHA" origin/main',
	)
})

describe("Noir crate manifest", () => {
	test("bridge-contracts gates every crate in contracts/crates.json, the manifest and its reader", async () => {
		const { loadManifest } = await import("./crates")
		const contracts = filtersOf("bridge-contracts.yml")["contracts"]
		const gated = (path: string) => contracts.some((pattern) => new Bun.Glob(pattern).match(path))
		for (const path of ["contracts/crates.json", "scripts/ci-cd/crates.ts"]) expect(gated(path), path).toBe(true)
		for (const crate of loadManifest().crates) {
			expect(gated(`${crate.path}/Nargo.toml`), crate.name).toBe(true)
			if (crate.nargo && "check" in crate.nargo) expect(gated(crate.nargo.check), crate.nargo.check).toBe(true)
		}
	})

	test("the Noir jobs take their crates from the manifest", () => {
		const jobs = workflow("_bridge-contracts.yml").jobs
		expect(jobs.parity.strategy.matrix.crate).toBe("${{ fromJSON(needs.crates.outputs.parity) }}")
		expect(jobs.txe.strategy.matrix.crate).toBe("${{ fromJSON(needs.crates.outputs.txe) }}")
		const runs = (job: string) => jobs[job].steps.map((step: { run?: string }) => step.run ?? "")
		expect(runs("noir")).toContain("bun scripts/ci-cd/crates.ts nargo-test")
		// Each job that fetches Noir dependencies checks its own fetch against the pins.
		for (const job of ["noir", "parity", "txe"])
			expect(
				runs(job).some((run: string) => /^ *bun scripts\/ci-cd\/crates\.ts check-pins "/m.test(run)),
				job,
			).toBe(true)
	})
})

type NightlyStep = Step & { "timeout-minutes"?: number }
const NIGHTLY_ACTION = /^\.\/\.nightly-ci\/\.github\/actions\/([^/]+)$/
type NightlyJob = { "timeout-minutes"?: number; "cache-mode"?: string; steps: NightlyStep[] }

/** A nightly job is bounded, reads caches only, keeps no credentials and calls this commit's actions. */
function expectNightlyJobReadsOnly(name: string, job: NightlyJob): void {
	expect(job["timeout-minutes"], name).toBeGreaterThan(0)
	expect(job["cache-mode"], `${name}: only reads caches`).toBe("read")
	for (const step of job.steps.filter((s) => s.uses)) {
		const uses = step.uses as string
		expect(uses, `${name}: actions/cache saves`).not.toMatch(/^actions\/cache@/)
		if (uses.startsWith("actions/checkout@")) expect(step.with?.["persist-credentials"], uses).toBe(false)
		if (uses.startsWith("./")) {
			expect(uses, "composite actions come from this workflow's commit").toMatch(/^\.\/\.nightly-ci\//)
			// An action of `run:` steps alone calls no cache action, so it takes no cache-save; the
			// job's `cache-mode: read`, required above, is what stops any save.
			const action = NIGHTLY_ACTION.exec(uses)?.[1]
			if (action === undefined || actionSteps(action).some((s) => s.uses !== undefined))
				expect(step.with?.["cache-save"], uses).toBe("false")
		}
	}
	expect(
		job.steps.some((s) => s.run?.includes("bun run nightly")),
		`${name}: runs the nightly`,
	).toBe(true)
}

/** Every caching step of a composite action is off, or saves nothing, when the caller passes `cache-save: false`. */
function expectActionSavesNothing(action: string): void {
	for (const step of actionSteps(action)) {
		const uses = step.uses ?? ""
		if (/^actions\/cache(\/save)?@/.test(uses))
			expect(step.if, `${action}: a saving cache step must be off when cache-save is false`).toContain("inputs.cache-save != 'false'")
		if (uses.startsWith("oven-sh/setup-bun@")) expect(step.with?.["no-cache"], action).toBe("${{ inputs.cache-save == 'false' }}")
	}
}

// The nightly runs integration-branch code in main's cache scope: a cache it saved could poison
// main's own workflows, and a persisted token or secret would be in reach of that code.
test("the nightly reads only: restore-only caches, this commit's actions, no credentials, a timeout", () => {
	const text = readFileSync(join(ROOT, ".github/workflows/nightly.yml"), "utf8")
	const wf = workflow("nightly.yml")
	expect(wf.permissions).toEqual({ contents: "read" })
	expect(text).not.toContain("secrets.")
	expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"])
	const jobs = Object.entries(wf.jobs) as [string, NightlyJob][]
	for (const [name, job] of jobs) expectNightlyJobReadsOnly(name, job)
	// Every composite action the job calls, so a new one cannot bring a saving cache along.
	const actions = jobs
		.flatMap(([, job]) => job.steps.map((s) => s.uses?.match(NIGHTLY_ACTION)?.[1]))
		.filter((name): name is string => Boolean(name))
	expect(actions).toContain("ppv2-fetch")
	expect(actions).toContain("setup-foundry")
	for (const action of actions) expectActionSavesNothing(action)
})

// A dispatch input interpolated into a script is shell injection; a wallet profile in an artifact
// would hand out a live wallet's store.
test("the nightly takes suite names as data and uploads only reports and logs, only on failure", () => {
	const text = readFileSync(join(ROOT, ".github/workflows/nightly.yml"), "utf8")
	const job = workflow("nightly.yml").jobs.nightly as NightlyJob
	const steps = job.steps
	const at = (pick: (s: NightlyStep) => boolean) => steps.findIndex(pick)
	const runAt = at((s) => s.run?.includes("bun run nightly") === true)
	const dropAt = at((s) => s.run?.includes("-type l -print -delete") === true)
	const uploadAt = at((s) => s.uses?.startsWith("actions/upload-artifact@") === true)
	const [run, drop, upload] = [steps[runAt], steps[dropAt], steps[uploadAt]]
	expect(run?.env).toEqual({ SUITES: "${{ inputs.suites }}", PP_E2E_STATE_DIR: "${{ runner.temp }}/nightly-e2e" })
	// Whole scripts: a guard without its exit, or a cleanup that deletes nothing, still reads alike.
	expect(run?.run).toBe(
		[
			"plain='^[a-z0-9 -]*$'",
			"name='^[a-z0-9][a-z0-9-]*$'",
			"if [[ ! $SUITES =~ $plain ]]; then",
			'  echo "suites: names are lowercase letters, digits and dashes, separated by spaces" >&2',
			"  exit 1",
			"fi",
			'read -ra names <<< "$SUITES"',
			'for n in "${names[@]}"; do',
			"  if [[ ! $n =~ $name ]]; then",
			`    echo "suites: '$n' starts with a dash" >&2`,
			"    exit 1",
			"  fi",
			"done",
			'bun run nightly "${names[@]}"',
			"",
		].join("\n"),
	)
	expect(drop?.run).toBe(
		[
			"shopt -s nullglob",
			'for run in "$STATE"/real-wallet-*; do',
			'  if [ -L "$run" ]; then rm -v -- "$run"; continue; fi',
			"  for p in test-results playwright-report sandbox.log stack.log build-wallet.log build-app.log; do",
			'    if [ -e "$run/$p" ] || [ -L "$run/$p" ]; then find "$run/$p" -type l -print -delete; fi',
			"  done",
			"done",
			"",
		].join("\n"),
	)
	// Context keys are case-insensitive, in either notation.
	expect(text.match(/inputs\s*(\.\s*suites\b|\[\s*['"]suites['"]\s*\])/gi)).toHaveLength(1)
	// A hang must fail the step with time left for setup before it and the upload after it.
	expect((job["timeout-minutes"] as number) - (run?.["timeout-minutes"] as number)).toBeGreaterThanOrEqual(20)
	expect(runAt < dropAt && dropAt < uploadAt, "run, then drop symlinks, then upload").toBe(true)
	expect(steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"))).toHaveLength(1)
	expect([drop?.id, drop?.if, upload?.if]).toEqual(["drop", "failure()", "failure() && steps.drop.outcome == 'success'"])
	expect(upload?.with?.["retention-days"]).toBeGreaterThan(0)
	expect(upload?.with?.["retention-days"]).toBeLessThanOrEqual(7)
	const base = "${{ runner.temp }}/nightly-e2e/real-wallet-*/"
	const paths = String(upload?.with?.path).trim().split("\n")
	const allowed = ["test-results/", "playwright-report/", "sandbox.log", "stack.log", "build-wallet.log", "build-app.log"]
	expect(paths.filter((p) => !p.startsWith("!"))).toEqual(allowed.map((p) => base + p))
	expect(paths.filter((p) => p.startsWith("!"))).toEqual([`!${base}real-wallet/**`])
})

// foundryup fetches an attestation at run time, and that endpoint's outage failed every job that
// installed Foundry; setup-foundry checks the release archive against a committed hash instead.
test("no workflow or action installs Foundry through foundryup or foundry-toolchain", () => {
	const steps: [string, Step][] = [
		...readdirSync(join(ROOT, ".github/workflows")).flatMap((file) =>
			(Object.entries(workflow(file).jobs) as [string, { steps?: Step[] }][]).flatMap(([job, { steps }]) =>
				(steps ?? []).map((step): [string, Step] => [`${file} ${job}`, step]),
			),
		),
		...readdirSync(join(ROOT, ".github/actions")).flatMap((action) =>
			actionSteps(action).map((step): [string, Step] => [action, step]),
		),
	]
	expect(steps.some(([, step]) => step.uses?.endsWith("/setup-foundry"))).toBe(true)
	for (const [where, step] of steps) {
		expect(step.uses ?? "", where).not.toMatch(/^foundry-rs\/foundry-toolchain@/i)
		expect(step.run ?? "", where).not.toMatch(/foundryup/i)
	}
	// A step can reach it through a script, so the code of every shell script in the repository counts too.
	const scripts = (walkable ??= listWalkable()).filter((f) => f.endsWith(".sh"))
	expect(scripts).toContain(".github/actions/setup-foundry/install.sh")
	for (const script of scripts) {
		const code = readFileSync(join(ROOT, script), "utf8").replace(/^\s*#.*$/gm, "")
		expect(code, script).not.toMatch(/foundryup/i)
	}
})

test("the unit-test workflow runs this suite", () => {
	const steps: { run?: string }[] = workflow("_unit-tests.yml").jobs["unit-tests"].steps
	expect(steps.map((step) => step.run)).toContain("bun run test:ci-gating")
})

// Each pull request saved its own copy of the browsers, readable only by it, and those copies
// pushed main's caches out under the repository's cache limit.
test("setup-playwright saves the browser cache only outside pull requests", () => {
	const action = readFileSync(join(ROOT, ".github/actions/setup-playwright/action.yml"), "utf8")
	const steps: { if?: string; uses?: string }[] = Bun.YAML.parse(action).runs.steps
	expect(
		steps.some((s) => /^actions\/cache@/.test(s.uses ?? "")),
		"actions/cache saves after every run",
	).toBe(false)
	const saves = steps.filter((s) => /^actions\/cache\/save@/.test(s.uses ?? ""))
	expect(saves).toHaveLength(1)
	// The whole expression: an added `||` clause would let a pull request save again.
	expect(saves[0]?.if).toBe(
		"steps.restore.outputs.cache-hit != 'true' && github.event_name != 'pull_request' && inputs.cache-save != 'false'",
	)
})

// A manifest naming Playwright `catalog:` does not change when the catalog moves it to a release with
// new browsers, so an exact hit on a manifest hash would skip their download.
test("setup-playwright keys the browser cache on the installed Playwright version", () => {
	const action = readFileSync(join(ROOT, ".github/actions/setup-playwright/action.yml"), "utf8")
	const steps: { id?: string; uses?: string; with?: { key?: string } }[] = Bun.YAML.parse(action).runs.steps
	const restore = steps.findIndex((s) => s.id === "restore")
	expect(steps[restore]?.with?.key).toBe("${{ runner.os }}-playwright-${{ steps.version.outputs.version }}")
	expect(steps.findIndex((s) => s.id === "version")).toBeLessThan(restore)
	expect(steps.filter((s) => s.with?.key !== undefined).map((s) => s.with?.key)).not.toContainEqual(expect.stringContaining("hashFiles"))
})
