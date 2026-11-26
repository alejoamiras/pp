/**
 * Anti-drift guard for the CI paths-filter gates. Each gate's target graph is recomputed from the
 * workspace manifests and the live filter must still cover it, so a new `@pp/*` dependency
 * added without gating it, or a `!` negation (dorny's some-quantifier footgun), fails here. The
 * npm packages the workspaces import sit outside that graph: a bump moves `bun.lock`, which every
 * gate covers. The unit-test workflow runs this file on every PR; the last test pins that.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
// Deployable leaves live under apps/ (none yet), libraries under packages/.
const APPS = new Set<string>()
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

/** A gate's pattern set must whole-package the target and src+manifest every transitive dep lib. */
function assertGraphCovered(patterns: string[], target: string, label: string) {
  expect(patterns, `${label}: target '${target}' must be whole-package gated`).toContain(`${dirOf(target)}/${target}/**`)
  for (const dep of transitiveDeps(target)) {
    expect(patterns, `${label}: dep lib '${dep}' src must be gated`).toContain(`packages/${dep}/src/**`)
    expect(patterns, `${label}: dep lib '${dep}' package.json must be gated`).toContain(`packages/${dep}/package.json`)
  }
}

const FILTER_WORKFLOWS = ["pr-quick.yml", "bridge-contracts.yml", "actionlint.yml", "pp-env.yml", "local-stack.yml", "pool-client.yml"]

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
}

// biome-ignore lint/suspicious/noExplicitAny: parsed-YAML shape is dynamic.
const workflow = (file: string): any => Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8"))

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

  test("the e2e kit build covers the kit graph, the sandbox harness it imports, and the files bridge-core bundles", () => {
    const kit = filtersOf("pr-quick.yml")["kit"]
    assertGraphCovered(kit, "e2e-kit", "kit")
    expect(kit, "the kit imports @pp/bridge-core/sandbox, which lives in scripts/").toContain("packages/bridge-core/scripts/**")
    const outside = importsOutside("bridge-core")
    expect(outside.length, "bridge-core bundles the hub artifact from contracts/").toBeGreaterThan(0)
    for (const path of outside) {
      expect(kit.some((pattern) => new Bun.Glob(pattern).match(path)), `kit must gate ${path}`).toBe(true)
    }
    const wf = workflow("pr-quick.yml")
    expect(wf.jobs.changes.outputs["needs-kit-build"]).toBe("${{ steps.compute.outputs.needs-kit-build }}")
    expect(wf.jobs["build-e2e-kit"].if).toBe("needs.changes.outputs.needs-kit-build == 'true'")
  })

  test("bridge-contracts covers the contracts, the harness package, its graph, and the shared vitest config", () => {
    const contracts = filtersOf("bridge-contracts.yml")["contracts"]
    expect(contracts, "the Solidity + Noir sources").toContain("contracts/bridge/**")
    assertGraphCovered(contracts, "bridge-core", "bridge-contracts")
    assertGraphCovered(contracts, "labelled-token", "bridge-contracts")
    for (const p of [
      "vitest.base.ts",
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "patches/**",
      ".github/actions/setup-aztec/**",
      ".github/actions/setup-bun/**",
    ]) {
      expect(contracts, `bridge-contracts must gate ${p}`).toContain(p)
    }
  })

  test("pp-env covers its package, its graph, the shared vitest config, and every action its suites job calls", () => {
    const ppEnv = filtersOf("pp-env.yml")["pp-env"]
    assertGraphCovered(ppEnv, "pp-env", "pp-env")
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
    assertGraphCovered(poolClient, "pool-client", "pool-client")
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
  expect(commits?.env).toEqual({ BASE_SHA: "${{ github.event.pull_request.base.sha }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}" })
})

// The excluded main needs every branch fetched, which fetch-depth 0 does.
test("Commitlint lints only the PR's own commits, excluding its base and main", () => {
  expect(workflow("commit-messages.yml").jobs["commit-messages"].steps[0].with["fetch-depth"]).toBe(0)
  const job = workflow("pr-quick.yml").jobs.commitlint
  expect(job.steps[0].with["fetch-depth"]).toBe(0)
  expect(job.steps.map((s: { run?: string }) => s.run)).toContain('bash scripts/ci-cd/commitlint-own.sh "$HEAD_SHA" "$BASE_SHA" origin/main')
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
    const noir = jobs.noir.steps.map((step: { run?: string }) => step.run ?? "")
    expect(noir).toContain("bun scripts/ci-cd/crates.ts nargo-test")
    expect(noir).toContain("bun scripts/ci-cd/crates.ts check-pins")
  })
})

// The nightly runs integration-branch code in main's cache scope: a cache it saved could poison
// main's own workflows, and a persisted token or secret would be in reach of that code.
test("the nightly reads only: restore-only caches, this commit's actions, no credentials, a timeout", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/nightly.yml"), "utf8")
  const wf = workflow("nightly.yml")
  expect(wf.permissions).toEqual({ contents: "read" })
  expect(text).not.toContain("secrets.")
  expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"])
  for (const [name, job] of Object.entries(wf.jobs) as [string, { "timeout-minutes"?: number; "cache-mode"?: string; steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }][]) {
    expect(job["timeout-minutes"], name).toBeGreaterThan(0)
    expect(job["cache-mode"], `${name}: only reads caches`).toBe("read")
    for (const step of job.steps.filter((s) => s.uses)) {
      const uses = step.uses as string
      expect(uses, `${name}: actions/cache saves`).not.toMatch(/^actions\/cache@/)
      if (uses.startsWith("actions/checkout@")) expect(step.with?.["persist-credentials"], uses).toBe(false)
      if (uses.startsWith("./")) {
        expect(uses, "composite actions come from this workflow's commit").toMatch(/^\.\/\.nightly-ci\//)
        expect(step.with?.["cache-save"], uses).toBe("false")
      }
      if (uses.startsWith("foundry-rs/foundry-toolchain@")) expect(step.with?.cache, uses).toBe(false)
    }
    expect(job.steps.map((s) => s.run)).toContain("bun run nightly")
  }
  for (const action of ["setup-bun", "setup-aztec"]) {
    const steps: { if?: string; uses?: string }[] = Bun.YAML.parse(readFileSync(join(ROOT, ".github/actions", action, "action.yml"), "utf8")).runs.steps
    for (const step of steps.filter((s) => s.uses?.startsWith("actions/cache"))) {
      const restoreOnly = step.if?.includes("inputs.cache-save == 'false'")
      expect(step.uses?.startsWith("actions/cache/restore@"), `${action}: ${step.if}`).toBe(Boolean(restoreOnly))
      if (!restoreOnly) expect(step.if, `${action}: a saving cache step must be off when cache-save is false`).toContain("inputs.cache-save != 'false'")
    }
  }
})

test("the unit-test workflow runs this suite", () => {
  const steps: { run?: string }[] = workflow("_unit-tests.yml").jobs["unit-tests"].steps
  expect(steps.map((step) => step.run)).toContain("bun run test:ci-gating")
})
