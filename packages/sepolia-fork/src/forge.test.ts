import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { claimPort, releasePorts, rowsOwnedBy } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { startForkAnvil } from "./anvil.ts"
import { checkForkConfig, checkForkResults, FORK_CASES, fixturePath, forgeEnv, runForkCases } from "./forge.ts"
import { leftovers, runFork } from "./run.ts"

const saved = { ...process.env }
afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
	Object.assign(process.env, saved)
})

test("forge's environment is built, never inherited: an ambient ffi switch or config file does not reach it", () => {
	process.env.FOUNDRY_FFI = "true"
	process.env.FOUNDRY_CONFIG = "/elsewhere/foundry.toml"
	process.env.DAPP_TEST_FFI = "1"
	expect(Object.keys(forgeEnv("/f.json")).sort()).toEqual(["FOUNDRY_PROFILE", "HOME", "PATH", "PP_FORK_FIXTURE"])
	expect(forgeEnv("/f.json")).toMatchObject({ FOUNDRY_PROFILE: "fork", PP_FORK_FIXTURE: "/f.json" })
})

const OK_CONFIG = { ffi: false, no_storage_caching: true, fs_permissions: [{ access: "read", path: "./out/fork" }] }

test("the fork profile must resolve to no ffi, no RPC storage cache and read access to out/fork alone", () => {
	checkForkConfig(OK_CONFIG)
	expect(() => checkForkConfig({ ...OK_CONFIG, ffi: true })).toThrow("ffi to true")
	expect(() => checkForkConfig({ ...OK_CONFIG, no_storage_caching: false })).toThrow("no_storage_caching to false")
	const perms = OK_CONFIG.fs_permissions
	expect(() => checkForkConfig({ ...OK_CONFIG, fs_permissions: [{ access: "read-write", path: "./out/fork" }] })).toThrow("not read-only")
	expect(() => checkForkConfig({ ...OK_CONFIG, fs_permissions: [...perms, { access: "read", path: "../../.." }] })).toThrow(
		"not read-only",
	)
})

const SUITE = "test/PortalFork.t.sol:PortalForkTest"
const report = (status: Record<string, string>, suite = SUITE) => ({
	[suite]: {
		test_results: Object.fromEntries(
			Object.entries(status).map(([sig, s]) => [sig, { status: s, reason: s === "Success" ? null : "boom" }]),
		),
	},
})
const ALL = Object.fromEntries(FORK_CASES.map((n) => [`${n}()`, "Success"]))

test("the run passes only when PortalForkTest alone ran exactly the four named cases and each passed", () => {
	expect(checkForkResults(report(ALL))).toBe(4)
	const { "testFork_secretHashIsBound()": _, ...three } = ALL
	expect(() => checkForkResults(report(three))).toThrow("testFork_secretHashIsBound() did not run")
	expect(() => checkForkResults(report({ ...ALL, "testFork_tamperedProofRejected()": "Failure" }))).toThrow(
		"testFork_tamperedProofRejected(): Failure (boom)",
	)
	expect(() => checkForkResults(report({ ...ALL, "setUp()": "Failure" }))).toThrow("unexpected entries: setUp(): Failure (boom)")
	// Same names under another suite, or with parameters, are not the cases.
	expect(() => checkForkResults(report(ALL, "test/Other.t.sol:OtherForkTest"))).toThrow(`not ${SUITE} alone`)
	expect(() => checkForkResults({ ...report(ALL), ...report(ALL, "test/Other.t.sol:OtherForkTest") })).toThrow(`not ${SUITE} alone`)
	const parameterized = Object.fromEntries(FORK_CASES.map((n) => [`${n}(uint256)`, "Success"]))
	expect(() => checkForkResults(report(parameterized))).toThrow("testFork_bridgeFromPool() did not run")
})

/** Runs the cases through a stand-in forge that answers `config` with a passing profile and `test` with `script`. */
async function withForge(script: string): Promise<string> {
	mkdirSync(join(homedir(), ".cache/pp/fork"), { recursive: true })
	const dir = mkdtempSync(join(homedir(), ".cache/pp/fork/forge-test-"))
	const bin = join(dir, "forge")
	writeFileSync(bin, `#!/bin/sh\n[ "$1" = config ] && { echo '${JSON.stringify(OK_CONFIG)}'; exit 0; }\n${script}\n`, { mode: 0o700 })
	const cleanup = new CleanupStack()
	try {
		return await runForkCases({ bin, dataDir: dir, cleanup, url: "http://127.0.0.1:9", block: 1, fixture: "/f.json" }).then(
			(n) => `passed ${n}`,
			(e: Error) => e.message,
		)
	} finally {
		await cleanup.run()
		rmSync(dir, { recursive: true, force: true })
	}
}

test("forge must print a passing report and exit 0: no tests found, or a non-zero exit after a pass, fails", async () => {
	expect(await withForge("echo 'No tests found in project!'")).toBe("forge test printed no report: No tests found in project!")
	const pass = JSON.stringify(report(ALL))
	expect(await withForge(`echo '${pass}'`)).toBe("passed 4")
	expect(await withForge(`echo '${pass}'; exit 3`)).toBe("forge test ended with exit code 3 after a passing report")
})

test("a fork started after its run was aborted frees the port it had just claimed and spawns nothing", async () => {
	const runId = `sepolia-fork-${process.pid}-aborted`
	const registry = mkdtempSync(join(homedir(), ".cache/pp/fork/registry-test-"))
	process.env.PP_PORTS_REGISTRY = join(registry, "ports.md")
	const abort = new AbortController()
	abort.abort(new Error("the run passed its deadline"))
	const spawned: number[] = []
	try {
		const start = startForkAnvil({
			endpoint: "http://127.0.0.1:9",
			block: 1n,
			runId,
			dataDir: registry,
			cleanup: new CleanupStack(),
			signal: abort.signal,
			bin: "/nonexistent/anvil",
			onSpawn: (pgid) => spawned.push(pgid),
		})
		expect(await start.catch((e: Error) => e.message)).toBe("the run passed its deadline")
		expect([rowsOwnedBy(runId), spawned.length]).toEqual([0, 0])
	} finally {
		rmSync(registry, { recursive: true, force: true })
	}
})

test("teardown counts the mock ASP's port row and the fixture directory as the run's own", async () => {
	const runId = `sepolia-fork-${process.pid}-leftovers`
	const registry = mkdtempSync(join(homedir(), ".cache/pp/fork/registry-test-"))
	process.env.PP_PORTS_REGISTRY = join(registry, "ports.md")
	const fixtureDir = dirname(fixturePath(runId))
	try {
		await claimPort(`${runId}:pool`, "pp-env-asp")
		mkdirSync(fixtureDir, { recursive: true })
		expect(leftovers(runId, join(registry, "absent"), undefined)).toEqual({ groups: 0, rows: 1, dirs: 1 })
		await releasePorts(`${runId}:pool`)
		rmSync(fixtureDir, { recursive: true, force: true })
		expect(leftovers(runId, join(registry, "absent"), undefined)).toEqual({ groups: 0, rows: 0, dirs: 0 })
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true })
		rmSync(registry, { recursive: true, force: true })
	}
})

test("a run past its deadline fails and still tears down to nothing", async () => {
	// An endpoint that accepts and never answers: only the deadline ends the run.
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) })
	const lines: string[] = []
	try {
		const err = await runFork({ endpoint: `http://127.0.0.1:${server.port}/`, deadlineMs: 300, log: (l) => lines.push(l) }).catch(
			(e: unknown) => e,
		)
		expect((err as Error).message).toBe("the run passed its 0.3 s deadline")
		expect(lines.at(-1)).toBe("teardown: groups=0 rows=0 dirs=0")
	} finally {
		server.stop(true)
	}
})
