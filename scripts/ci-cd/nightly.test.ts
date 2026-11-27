import { spawnSync } from "node:child_process"
import { expect, test } from "bun:test"
import { boundedSuite, forgePassed, SUITES, verdict, vitestPassed } from "../nightly"

const forgeSuite = SUITES[0]

test("a nightly suite fails when it exits non-zero or passes no test", () => {
	const ran = "Suite result: ok. 3 passed; 0 failed; 0 skipped\nSuite result: ok. 1 passed; 0 failed; 0 skipped"
	expect(forgePassed(ran)).toBe(4)
	expect(verdict(forgeSuite, 0, ran)).toBeUndefined()
	expect(verdict(forgeSuite, 0, "No tests match the provided pattern")).toBe(`${forgeSuite.name}: matched no test`)
	expect(verdict(forgeSuite, 1, ran)).toBe(`${forgeSuite.name}: exited 1`)
})

test("a vitest suite counts only its summary's passed tests, colored or not", () => {
	const colored = "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m (1)\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m | \u001b[33m3 skipped\u001b[39m (4)"
	expect(vitestPassed(colored)).toBe(1)
	expect(vitestPassed("      Tests  1 failed | 2 passed (3)")).toBe(2)
	expect(vitestPassed("      Tests  4 skipped (4)")).toBe(0)
})

test("suite names are unique", () => {
	expect(new Set(SUITES.map((s) => s.name)).size).toBe(SUITES.length)
})

test("a bounded suite keeps the caller's seed, prints it again on failure, and passes only at its count", () => {
	const suite = boundedSuite({ name: "probe", cwd: ".", argv: ["bash", "-c", "exit 3"], minutes: 1, expected: 2 })
	const run = spawnSync(suite.command[0] as string, suite.command.slice(1), {
		env: { ...process.env, FC_SEED: "42", SHELLOPTS: "errexit" },
		encoding: "utf8",
	})
	expect(run.status).toBe(3)
	expect(run.stdout).toContain("probe: FC_SEED=42, bound 60s")
	expect(run.stderr).toContain("probe: exited 3 (137: the bound or another SIGKILL); replay with FC_SEED=42")
	expect(verdict(suite, 0, "      Tests  1 passed | 1 skipped (2)")).toBe("probe: 1 tests passed, expected 2")
	expect(verdict(suite, 0, "      Tests  2 passed (2)")).toBeUndefined()
})
