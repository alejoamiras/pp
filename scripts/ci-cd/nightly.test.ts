import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { REAL_WALLET_TESTS } from "../../packages/e2e-kit/real-wallet/count-reporter"
import { FORK_CASES } from "../../packages/sepolia-fork/src/forge"
import { OPERATOR_FORK_STEPS } from "../../packages/testnet/src/rehearse/operator-steps"
import {
	boundedSuite,
	countVerdict,
	expectedLine,
	expectedPassed,
	forgePassed,
	SEPOLIA_FORK_ENDPOINT,
	rehearseListed,
	rehearsedSteps,
	SUITES,
	sepoliaForkPassed,
	verdict,
	vitestListed,
	vitestPassed,
} from "../nightly"

const ROOT = join(import.meta.dir, "..", "..")
const SOURCE = readFileSync(join(ROOT, "scripts", "nightly.ts"), "utf8")

const forgeSuite = SUITES[0]

test("a nightly suite fails when it exits non-zero or passes no test", () => {
	const ran = "Suite result: ok. 3 passed; 0 failed; 0 skipped\nSuite result: ok. 1 passed; 0 failed; 0 skipped"
	expect(forgePassed(ran)).toBe(4)
	expect(verdict(forgeSuite, 0, ran)).toBeUndefined()
	expect(verdict(forgeSuite, 0, "No tests match the provided pattern")).toBe(`${forgeSuite.name}: matched no test`)
	expect(verdict(forgeSuite, 1, ran)).toBe(`${forgeSuite.name}: exited 1`)
})

test("a vitest suite counts only its summary's passed tests, colored or not", () => {
	const colored =
		"\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m (1)\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m | \u001b[33m3 skipped\u001b[39m (4)"
	expect(vitestPassed(colored)).toBe(1)
	expect(vitestPassed("      Tests  1 failed | 2 passed (3)")).toBe(2)
	expect(vitestPassed("      Tests  4 skipped (4)")).toBe(0)
})

test("suite names are unique", () => {
	expect(new Set(SUITES.map((s) => s.name)).size).toBe(SUITES.length)
})

test("a bounded suite keeps the caller's seed, prints it again on failure, and passes only at its count", () => {
	const list = { argv: ["true"], count: () => 2 }
	const suite = boundedSuite({ name: "probe", cwd: ".", argv: ["bash", "-c", "exit 3"], minutes: 1, expected: 2, list })
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

/**
 * A key rides in userinfo, a query, a fragment or a path, so the committed endpoint carries none of them:
 * https, a bare host on the default port, the root path. Checked on the raw text too, since `URL` drops an
 * empty `?` or `#`.
 */
const keylessGateway = (raw: string): boolean => {
	const url = URL.parse(raw)
	return (
		url !== null &&
		url.protocol === "https:" &&
		url.username === "" &&
		url.password === "" &&
		url.port === "" &&
		url.pathname === "/" &&
		!/[@?#]/.test(raw)
	)
}

test("the sepolia-fork suite gets a committed keyless gateway, and counts only its runner's closing line", () => {
	const suite = SUITES.find((s) => s.name === "sepolia-fork")
	expect(suite?.env).toEqual({ SEPOLIA_RPC_URL: SEPOLIA_FORK_ENDPOINT })
	expect(keylessGateway(SEPOLIA_FORK_ENDPOINT)).toBe(true)
	expect(URL.parse(SEPOLIA_FORK_ENDPOINT)?.hostname).toBe("sepolia.gateway.tenderly.co")
	for (const keyed of [
		"https://user:pass@sepolia.gateway.tenderly.co/",
		"https://key@sepolia.gateway.tenderly.co/",
		"https://sepolia.gateway.tenderly.co/?key=abc",
		"https://sepolia.gateway.tenderly.co/?",
		"https://sepolia.gateway.tenderly.co/#abc",
		"http://sepolia.gateway.tenderly.co/",
		"https://sepolia.gateway.tenderly.co/v2/abc",
		"https://sepolia.gateway.tenderly.co:8443/",
	])
		expect(keylessGateway(keyed), keyed).toBe(false)
	expect(suite?.expected).toBe(4)
	expect(sepoliaForkPassed("sepolia-fork: 4 fork cases passed\n")).toBe(4)
	expect(sepoliaForkPassed("Suite result: ok. 4 passed; 0 failed; 0 skipped")).toBe(0)
})

test("the real-wallet suite counts only its reporter's one line, at the reporter's total", () => {
	const suite = SUITES.find((s) => s.name === "real-wallet")
	expect(suite).toMatchObject({ cwd: "packages/e2e-kit", command: ["bun", "run", "test:real-wallet"], expected: 5 })
	expect(suite?.expected, "the suite and the kit's reporter agree on the total").toBe(REAL_WALLET_TESTS)
	// It starts detached process groups, which a bounded suite's kill would orphan.
	expect(suite?.command[0]).not.toBe("bash")
	expect(suite?.prepare?.at(-1)).toEqual(["forge", "build", "--root", "contracts/bridge/evm", "--skip", "test", "script"])
	const count = expectedPassed("real-wallet", 5)
	const ran = "  5 passed (2.1m)\nreal-wallet: 5/5 passed as expected\n[real-wallet] state in s; nothing of the run survives\n"
	expect(count(ran)).toBe(5)
	expect(count("\u001b[2mreal-wallet: 5/5 passed as expected\u001b[22m\n")).toBe(5)
	if (suite) {
		expect(verdict(suite, 0, ran)).toBeUndefined()
		expect(verdict(suite, 0, "  1 skipped\n  4 passed (2.1m)\nreal-wallet: 4/5 passed as expected\n")).toBe(
			"real-wallet: 4 tests passed, expected 5",
		)
	}
	expect(count("  5 passed (2.1m)\n")).toBe(0)
	expect(count("real-wallet: 5/5 passed as expected\nreal-wallet: 5/5 passed as expected\n")).toBe(0)
	expect(count("real-wallet: 5/6 passed as expected\n")).toBe(0)
	expect(count("other: 5/5 passed as expected\n")).toBe(0)
})

test("every bounded suite has a pull-request listing, and one the check cannot derive is refused", () => {
	const bounded = SUITES.filter((s) => s.command[0] === "bash" && s.command[1] === "-c")
	expect(bounded.map((s) => s.name)).toEqual([
		"label-paths-properties",
		"bridge-spec-properties",
		"bridge-spec-fresh-vectors",
		"bridge-client-model",
		"testnet-pool1-rehearsal",
	])
	for (const s of bounded) expect(s.list, s.name).toBeDefined()
	const refused =
		(argv: string[], cwd = "packages/bridge-core") =>
		() =>
			boundedSuite({ name: "probe", cwd, argv, minutes: 1, expected: 1 })
	expect(refused(["bash", "-c", "true"])).toThrow("probe: a bounded suite needs a pull-request listing")
	expect(refused(["bun", "run", "test"])).toThrow("needs a pull-request listing")
	expect(refused(["bun", "run", "test", "--coverage"])).toThrow("needs a pull-request listing")
	expect(refused(["bun", "run", "test", "src/x.test.ts"], "."), "the root's test script is not vitest").toThrow(
		"needs a pull-request listing",
	)
	expect(refused(["bun", "run", "test", "src/x.test.ts"])().list?.argv).toEqual([
		"bun",
		"--bun",
		"vitest",
		"list",
		"src/x.test.ts",
		"--json",
	])
})

test("a listing counts only vitest's JSON array", () => {
	expect(vitestListed('[{"name":"a","file":"f"},{"name":"b","file":"f"}]\n')).toBe(2)
	expect(vitestListed("(!) a warning\n[]")).toBe(0)
	expect(vitestListed("a 2 passed\n")).toBe(0)
	expect(vitestListed('{"name":"a"}')).toBe(0)
})

test("a count that differs from `expected` names the suite and the line that pins it", () => {
	const suite = SUITES.find((s) => s.name === "bridge-client-model")
	if (!suite?.expected) throw new Error("bridge-client-model has no expected count")
	const line = expectedLine(SOURCE, suite.name) ?? 0
	expect(SOURCE.split("\n")[line - 1]?.trim()).toBe(`expected: ${suite.expected},`)
	expect(countVerdict(suite, suite.expected, SOURCE)).toBeUndefined()
	expect(countVerdict(suite, suite.expected + 1, SOURCE)).toBe(
		`bridge-client-model: ${suite.expected + 1} tests listed, expected ${suite.expected}; set \`expected: ${suite.expected + 1},\` at scripts/nightly.ts:${line}`,
	)
	expect(countVerdict(suite, 0, SOURCE)).toBe(
		`bridge-client-model: its listing showed no test; scripts/nightly.ts:${line} pins ${suite.expected}`,
	)
	for (const s of SUITES.filter((s) => s.list)) expect(expectedLine(SOURCE, s.name), s.name).toBeGreaterThan(0)
})

test("the unit-test workflow checks the counts on every pull request", () => {
	const unit = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/_unit-tests.yml"), "utf8")).jobs["unit-tests"]
	expect(unit.if).toBeUndefined()
	expect(unit.steps.map((step: { run?: string }) => step.run)).toContain("bun scripts/nightly.ts --counts")
	const quality = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/pr-quick.yml"), "utf8")).jobs
	expect(quality["unit-tests"]).toMatchObject({ uses: "./.github/workflows/_unit-tests.yml" })
	expect(quality["unit-tests"].if).toBeUndefined()
})

test("the sepolia-fork suite expects exactly its runner's named cases", () => {
	expect(SUITES.find((s) => s.name === "sepolia-fork")?.expected).toBe(FORK_CASES.length)
})

test("the pool1 rehearsal counts the steps of its one `rehearsed` line, at the steps the rehearsal lists", () => {
	expect(SUITES.find((s) => s.name === "testnet-pool1-rehearsal")?.expected).toBe(OPERATOR_FORK_STEPS.length)
	const count = rehearsedSteps("pool1")
	const line = (part: string, steps: number) =>
		`${JSON.stringify({ event: "rehearsed", part, block: "1", asp: Array.from({ length: steps }, (_, i) => ({ step: `s${i}`, requests: [] })) })}\n`
	expect(count(`testnet-pool1-rehearsal: FC_SEED=1, bound 300s\n[pool1] seed exited 2\n${line("pool1", 8)}`)).toBe(8)
	expect(count(`\u001b[2m${line("pool1", 8)}`)).toBe(8)
	expect(count(line("pool1", 8) + line("pool1", 8))).toBe(0)
	expect(count(line("fork", 8))).toBe(0)
	expect(count('{"event":"rehearsed","part":"pool1","asp":[\n')).toBe(0)
	expect(count('{"event":"rehearsed","part":"pool1"}\n')).toBe(0)
	expect(count("[rehearse] pool1 failed: seed exited 1\n")).toBe(0)
	const listed = rehearseListed("pool1")
	expect(listed("rehearse pool1: 8 steps listed\n")).toBe(8)
	expect(listed("rehearse fork: 8 steps listed\n")).toBe(0)
	expect(listed("rehearse pool1: 8 steps listed, and more\n")).toBe(0)
})
