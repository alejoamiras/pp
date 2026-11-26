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

const FILTER_WORKFLOWS = ["pr-quick.yml", "bridge-contracts.yml", "actionlint.yml", "pp-env.yml"]

/**
 * The check-run each PR workflow's aggregator job produces. Branch protection matches these by
 * name, so a renamed job that is not repointed there blocks every merge; this pin fails first.
 */
const AGGREGATOR_CHECKS: Record<string, string> = {
  "pr-quick.yml": "quality-status",
  "bridge-contracts.yml": "bridge-contracts-status",
  "actionlint.yml": "actionlint-status",
  "pp-env.yml": "pp-env-status",
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

  test("pp-env covers its package, its graph, and every action its suites job calls", () => {
    const ppEnv = filtersOf("pp-env.yml")["pp-env"]
    assertGraphCovered(ppEnv, "pp-env", "pp-env")
    const calls: string[] = workflow("pp-env.yml")
      .jobs.suites.steps.map((step: { uses?: string }) => step.uses)
      .filter((uses: string | undefined) => uses?.startsWith("./.github/actions/"))
    expect(calls.length).toBeGreaterThan(0)
    for (const p of [...calls.map((c) => `${c.slice(2)}/**`), "package.json", "bun.lock", "bunfig.toml", "patches/**"]) {
      expect(ppEnv, `pp-env must gate ${p}`).toContain(p)
    }
    expect(workflow("pp-env.yml").jobs.suites.if).toBe("needs.changes.outputs.pp-env == 'true'")
  })
})

test("the unit-test workflow runs this suite", () => {
  const steps: { run?: string }[] = workflow("_unit-tests.yml").jobs["unit-tests"].steps
  expect(steps.map((step) => step.run)).toContain("bun run test:ci-gating")
})
