import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CleanupStack } from "@pp/run-isolation/process"
import { checkForkConfig, checkForkResults, FORK_CASES, forgeEnv, runForkCases } from "./forge.ts"
import { runFork } from "./run.ts"

const saved = { ...process.env }
afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
})

test("forge's environment is built, never inherited: an ambient ffi switch or config file does not reach it", () => {
	process.env.FOUNDRY_FFI = "true"
	process.env.FOUNDRY_CONFIG = "/elsewhere/foundry.toml"
	process.env.DAPP_TEST_FFI = "1"
	expect(Object.keys(forgeEnv("/f.json")).sort()).toEqual(["FOUNDRY_PROFILE", "HOME", "PATH", "PP_FORK_FIXTURE"])
	expect(forgeEnv("/f.json")).toMatchObject({ FOUNDRY_PROFILE: "fork", PP_FORK_FIXTURE: "/f.json" })
})

test("the fork profile must resolve to no ffi and read access to out/fork alone", () => {
	const ok = { ffi: false, fs_permissions: [{ access: "read", path: "./out/fork" }] }
	checkForkConfig(ok)
	expect(() => checkForkConfig({ ...ok, ffi: true })).toThrow("ffi to true")
	expect(() => checkForkConfig({ ...ok, fs_permissions: [{ access: "read-write", path: "./out/fork" }] })).toThrow("not read-only")
	expect(() => checkForkConfig({ ...ok, fs_permissions: [...ok.fs_permissions, { access: "read", path: "../../.." }] })).toThrow(
		"not read-only",
	)
})

test("the run passes only when exactly the four named cases ran and passed", () => {
	const results = (status: Record<string, string>) => ({
		"test/PortalFork.t.sol:PortalForkTest": {
			test_results: Object.fromEntries(
				Object.entries(status).map(([n, s]) => [`${n}()`, { status: s, reason: s === "Success" ? null : "boom" }]),
			),
		},
	})
	const all = Object.fromEntries(FORK_CASES.map((n) => [n, "Success"]))
	expect(checkForkResults(results(all))).toBe(4)
	const { testFork_secretHashIsBound: _, ...three } = all
	expect(() => checkForkResults(results(three))).toThrow("testFork_secretHashIsBound did not run")
	expect(() => checkForkResults(results({ ...all, testFork_tamperedProofRejected: "Failure" }))).toThrow(
		"testFork_tamperedProofRejected: Failure (boom)",
	)
	expect(() => checkForkResults(results({ ...all, testFork_extra: "Success" }))).toThrow("unexpected cases ran: testFork_extra")
})

test("forge finding no test exits 0 with no report, and the run fails naming what it printed", async () => {
	mkdirSync(join(homedir(), ".cache/pp/fork"), { recursive: true })
	const dir = mkdtempSync(join(homedir(), ".cache/pp/fork/forge-test-"))
	const bin = join(dir, "forge")
	const config = JSON.stringify({ ffi: false, fs_permissions: [{ access: "read", path: "./out/fork" }] })
	writeFileSync(bin, `#!/bin/sh\n[ "$1" = config ] && { echo '${config}'; exit 0; }\necho 'No tests found in project!'\n`, {
		mode: 0o700,
	})
	const cleanup = new CleanupStack()
	try {
		const err = await runForkCases({ bin, dataDir: dir, cleanup, url: "http://127.0.0.1:9", block: 1, fixture: "/f.json" }).catch(
			(e: unknown) => e,
		)
		expect((err as Error).message).toBe("forge test printed no report: No tests found in project!")
	} finally {
		await cleanup.run()
		rmSync(dir, { recursive: true, force: true })
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
