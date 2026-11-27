import { spawnSync } from "node:child_process"
import { expect, test } from "bun:test"
import {
	boundedSuite,
	expectedPassed,
	forgePassed,
	SEPOLIA_FORK_ENDPOINT,
	SUITES,
	sepoliaForkPassed,
	verdict,
	vitestPassed,
} from "../nightly"

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
	expect(suite).toMatchObject({ cwd: "packages/e2e-kit", command: ["bun", "run", "test:real-wallet"], expected: 3 })
	// It starts detached process groups, which a bounded suite's kill would orphan.
	expect(suite?.command[0]).not.toBe("bash")
	expect(suite?.prepare?.at(-1)).toEqual(["forge", "build", "--root", "contracts/bridge/evm", "--skip", "test", "script"])
	const count = expectedPassed("real-wallet", 3)
	const ran = "  3 passed (2.1m)\nreal-wallet: 3/3 passed as expected\n[real-wallet] state in s; nothing of the run survives\n"
	expect(count(ran)).toBe(3)
	expect(count("\u001b[2mreal-wallet: 3/3 passed as expected\u001b[22m\n")).toBe(3)
	if (suite) {
		expect(verdict(suite, 0, ran)).toBeUndefined()
		expect(verdict(suite, 0, "  1 skipped\n  2 passed (2.1m)\nreal-wallet: 2/3 passed as expected\n")).toBe(
			"real-wallet: 2 tests passed, expected 3",
		)
	}
	expect(count("  3 passed (2.1m)\n")).toBe(0)
	expect(count("real-wallet: 3/3 passed as expected\nreal-wallet: 3/3 passed as expected\n")).toBe(0)
	expect(count("real-wallet: 3/4 passed as expected\n")).toBe(0)
	expect(count("other: 3/3 passed as expected\n")).toBe(0)
})
