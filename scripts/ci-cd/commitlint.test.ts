/** The commits a PR brings and the squash subject it will write, as Quality and commit-messages.yml lint them. */
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const temps: string[] = []
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "pp-commitlint-"))
	temps.push(dir)
	return dir
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
	spawnSync("bash", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } })

describe("commitlint-own.sh", () => {
	// main gains a commit with a bad subject after bridge-v1 branched; a sync merges it in.
	const dir = tempDir()
	const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }
	const git = (...args: string[]) => {
		const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, ...id },
		})
		if (r.status !== 0) throw new Error(r.stderr)
		return r.stdout.trim()
	}
	const commit = (message: string) => git("commit", "-q", "--allow-empty", "-m", message)
	git("init", "-q", "-b", "main")
	commit("feat: start")
	git("branch", "bridge-v1")
	commit("feat(pp-env): Privacy Pools v2 on a local anvil (#5)")
	commit("fix: a later commit on main (#8)")
	git("checkout", "-q", "-b", "sync", "bridge-v1")
	git("merge", "-q", "--no-ff", "-m", "chore: merge main into bridge-v1", "main")
	const lint = () => run([join(ROOT, "scripts/ci-cd/commitlint-own.sh"), "sync", "bridge-v1", "main"], dir)

	test("a sync lints only its merge commit, not main's history", () => {
		expect(git("rev-list", "bridge-v1..sync").split("\n")).toHaveLength(3)
		const r = lint()
		expect(r.stdout.match(/^--- /gm)).toHaveLength(1)
		expect(r.stdout).toContain("chore: merge main into bridge-v1")
		expect(r.status, r.stdout + r.stderr).toBe(0)
	})

	test("a bad commit of the PR's own still fails", () => {
		commit("Fix: Capitalised subject")
		const r = lint()
		expect(r.stdout).toContain("subject-case")
		expect(r.status).toBe(1)
	})
})

describe("lint-pr-title.sh", () => {
	const title = (PR_TITLE: string, PR_NUMBER = "123") =>
		run([join(ROOT, "scripts/ci-cd/lint-pr-title.sh")], ROOT, { PR_TITLE, PR_NUMBER }).status

	// Five commitlint processes in a row: about 3 s at load 250 and past bun's 5 s default near load
	// 300 on a 192-core host, so the bound is explicit: four times the default.
	test("the title plus its squash suffix must pass commitlint", () => {
		expect(title("fix(ci): lint only a pull request's own commits")).toBe(0)
		expect(title("feat(pp-env): Privacy Pools v2 on a local anvil")).toBe(1)
		// commitlint skips these by default; a title is always ours to write.
		expect(title("Automatic merge release notes")).toBe(1)
		// 95 characters pass alone; " (#123)" takes the subject to 102.
		const long = `fix: ${"a".repeat(90)}`
		expect(
			spawnSync("bash", ["-c", `printf '%s\\n' "$T" | ${ROOT}/node_modules/.bin/commitlint --cwd ${ROOT}`], {
				env: { ...process.env, T: long },
			}).status,
		).toBe(0)
		expect(title(long)).toBe(1)
	}, 20_000)

	test("a title shaped like shell is data", () => {
		const dir = tempDir()
		const marker = join(dir, "ran")
		title(`fix: $(touch ${marker}) \`touch ${marker}\`; touch ${marker}`)
		expect(existsSync(marker)).toBe(false)
	})
})
