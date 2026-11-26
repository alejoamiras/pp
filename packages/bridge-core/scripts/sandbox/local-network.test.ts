import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	assertSocketRoom,
	killGroup,
	nodeEnv,
	own,
	parseListeners,
	runLeftovers,
	SANDBOX_CACHE_DIR,
	SANDBOX_TMP_ROOT,
	startLocalNetwork,
	strayListeners,
} from "./local-network"

const freshRunId = (label: string) => `${label}-${randomBytes(4).toString("hex")}`

const module = join(import.meta.dirname, "local-network.ts")

describe("reapOnSignals", () => {
	it("stays registered after a signal, so a second one never finds signal-exit alone", () => {
		// In a child: emitting a signal here would also run the test runner's own handlers.
		const body = `const { reapOnSignals } = await import(${JSON.stringify(module)}); const n = process.listenerCount("SIGTERM"); reapOnSignals(() => new Promise(() => {})); process.emit("SIGTERM"); console.log(process.listenerCount("SIGTERM") - n)`
		expect(execFileSync("bun", ["-e", body]).toString().trim()).toBe("1")
	})
})

describe("assertSocketRoom", () => {
	it("accepts the harness's own temp root and refuses one the node's IPC socket names would overflow", () => {
		expect(() => assertSocketRoom(join(SANDBOX_TMP_ROOT, "0123abcd"))).not.toThrow()
		// "/" + dir + "/cdb-ts-4194304-999-999.sock" is 29 bytes beyond the dir name.
		expect(() => assertSocketRoom(`/${"d".repeat(78)}`)).not.toThrow()
		expect(() => assertSocketRoom(`/${"d".repeat(79)}`)).toThrow(/no room for the node's IPC sockets \(108 > 107 bytes\)/)
	})
})

describe("teardownNetwork", () => {
	const teardownRun = (env: Record<string, string> = {}) => {
		const config = join(import.meta.dirname, "fixtures/failing-teardown/vitest.config.ts")
		const run = spawnSync("bun", ["--bun", "vitest", "run", "--config", config], {
			cwd: join(import.meta.dirname, "../.."),
			encoding: "utf8",
			env: { ...process.env, ...env },
		})
		// Not the error's message: under Bun about one run in 25 prints the error without it.
		expect(run.stdout + run.stderr).toContain("error during close")
		expect(run.status).toBe(1)
	}

	it("fails a vitest run whose global teardown finds leftovers", () => teardownRun())

	it("fails the run and still cleans up when the stop itself throws", () => {
		const marker = join(mkdtempSync(join(tmpdir(), "pp-teardown-")), "cleaned")
		teardownRun({ TEARDOWN_CASE: "stop-throws", TEARDOWN_MARKER: marker })
		expect(existsSync(marker)).toBe(true)
	})
})

describe("the host port registry", () => {
	// In a child whose HOME is a temp dir, so no test ever holds the host's own registry lock. The
	// child's clock advances on every read: the lock's stale window and the wait's deadline both run on
	// it, so the waits finish in a few seconds.
	const inChild = (advanceMs: number, lockAgeMs: number, body: string) => {
		const home = mkdtempSync(join(tmpdir(), "pp-registry-"))
		try {
			mkdirSync(join(home, ".agents"))
			const lock = join(home, ".agents", "ports.md.lock")
			const script = `const { utimesSync, writeFileSync } = await import("node:fs"); const m = await import(${JSON.stringify(module)});
				writeFileSync(${JSON.stringify(lock)}, ""); const at = new Date(Date.now() - ${lockAgeMs}); utimesSync(${JSON.stringify(lock)}, at, at);
				let now = Date.now(); Date.now = () => (now += ${advanceMs}); ${body}`
			return spawnSync("bun", ["-e", script], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 })
		} finally {
			rmSync(home, { recursive: true, force: true })
		}
	}

	it("waits out a dead holder's lock before giving up", () => {
		const run = inChild(200, 0, `await m.registerHostPorts("lock-test", "t", { a: 1 }, process.pid); console.log("claimed")`)
		expect(run.stderr).toBe("")
		expect(run.stdout.trim()).toBe("claimed")
	}, 30_000)

	it("throws from a release whose lock never clears", () => {
		const run = inChild(
			1_000,
			-3_600_000,
			`await m.releaseHostPorts("lock-test", { a: 1 }).then(() => console.log("released"), (e) => console.log(e.message))`,
		)
		expect(run.stdout).toMatch(/stayed locked — remove the rows owned by lock-test \(ports 1\) by hand/)
	}, 30_000)
})

describe("nodeEnv", () => {
	it("passes the node only what the harness sets, HOME and the named overrides", () => {
		const saved = { ...process.env }
		Object.assign(process.env, { ETHEREUM_HOSTS: "https://rpc.example", AZTEC_DISABLE_ADMIN_API_KEY: "1", LOG_LEVEL: "debug" })
		try {
			const tool = { anvilBin: "", aztecBin: "", aztecEntry: "", internalBin: "/toolchain/internal-bin" }
			const env = nodeEnv(tool, "http://127.0.0.1:1", { data: "/data", tmp: "/tmp-run" })
			expect(env.ETHEREUM_HOSTS).toBe("http://127.0.0.1:1")
			expect(env.AZTEC_DISABLE_ADMIN_API_KEY).toBeUndefined()
			expect(env.LOG_LEVEL).toBe("debug")
			expect(env.HOME).toBe(process.env.HOME)
			expect(env.PATH?.startsWith("/toolchain/internal-bin")).toBe(true)
			expect([env.DATA_DIRECTORY, env.TMPDIR]).toEqual(["/data", "/tmp-run"])
			const extra = Object.keys(env).filter(
				(k) => !/^(HOME|PATH|LOG_LEVEL|TEST_ACCOUNTS|DEPLOY_AZTEC_CONTRACTS_SALT|DATA_DIRECTORY|TMPDIR)$/.test(k),
			)
			for (const k of extra) expect(saved[k], `${k} came from the parent environment`).toBeUndefined()
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
			Object.assign(process.env, saved)
		}
	})
})

describe("runLeftovers", () => {
	it("names a run's directory and live process group until both are gone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pp-leftovers-"))
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
		const pgid = child.pid as number
		const exited = new Promise((resolve) => child.once("exit", resolve))
		const run = { runId: `leftovers-test-${randomBytes(4).toString("hex")}`, dirs: [dir], pgids: [pgid] }
		try {
			expect(runLeftovers(run)).toEqual([`directory ${dir}`, `process group ${pgid}`])
		} finally {
			process.kill(-pgid, "SIGKILL")
			rmSync(dir, { recursive: true, force: true })
		}
		await exited
		expect(runLeftovers(run)).toEqual([])
	})
})

describe("killGroup", () => {
	it("kills the members a group keeps after its leader has already exited", async () => {
		const leader = own(spawn("sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" }))
		await leader.exited
		const pgid = leader.child.pid as number
		const run = { runId: freshRunId("killgroup-test"), dirs: [], pgids: [pgid] }
		try {
			expect(runLeftovers(run)).toEqual([`process group ${pgid}`])
			await killGroup(leader)
			expect(runLeftovers(run)).toEqual([])
		} finally {
			try {
				process.kill(-pgid, "SIGKILL")
			} catch {}
		}
	})
})

describe("startLocalNetwork", () => {
	const stubToolchain = () => {
		const root = mkdtempSync(join(tmpdir(), "pp-toolchain-"))
		for (const bin of [
			"bin/aztec-anvil",
			"node_modules/.bin/aztec",
			"internal-bin/forge",
			"internal-bin/anvil",
			"node_modules/dest/bin/index.js",
		]) {
			mkdirSync(dirname(join(root, bin)), { recursive: true })
			writeFileSync(join(root, bin), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
		}
		return root
	}
	const listeners = () => ["SIGTERM", "exit"].map((e) => process.listenerCount(e))

	it("releases its ports and its handlers when a step after the claim fails", async () => {
		const root = stubToolchain()
		mkdirSync(SANDBOX_CACHE_DIR, { recursive: true })
		const before = listeners()
		const blockers: string[] = []
		try {
			for (const signals of [true, false]) {
				// A regular file where the run's data directory goes: creating it fails after the claim.
				const runId = freshRunId("start-test")
				blockers.push(join(SANDBOX_CACHE_DIR, runId))
				writeFileSync(join(SANDBOX_CACHE_DIR, runId), "")
				await expect(startLocalNetwork({ runId, toolchainRoot: root, signals })).rejects.toThrow(/EEXIST|exists/)
				expect(listeners()).toEqual(before)
				expect(runLeftovers({ runId, dirs: [], pgids: [] })).toEqual([])
				// The file that blocked the run was not the run's to delete.
				expect(existsSync(join(SANDBOX_CACHE_DIR, runId))).toBe(true)
			}
		} finally {
			rmSync(root, { recursive: true, force: true })
			for (const b of blockers) rmSync(b, { force: true })
		}
	})

	it("refuses a data directory it did not create", async () => {
		const root = stubToolchain()
		const runId = freshRunId("start-test")
		const dir = join(SANDBOX_CACHE_DIR, runId)
		mkdirSync(dir, { recursive: true })
		try {
			await expect(startLocalNetwork({ runId, toolchainRoot: root, signals: false })).rejects.toThrow(/already exists/)
			expect(existsSync(dir)).toBe(true)
			expect(runLeftovers({ runId, dirs: [], pgids: [] })).toEqual([])
		} finally {
			rmSync(root, { recursive: true, force: true })
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("refuses a run id that is not one path segment", async () => {
		await expect(startLocalNetwork({ runId: "../escape" })).rejects.toThrow(/not a single path segment/)
	})

	it("refuses a run id that names the shared logs or another run's artifacts", async () => {
		for (const runId of ["logs", "bridge-integration-1-x-artifacts"]) {
			await expect(startLocalNetwork({ runId, signals: false })).rejects.toThrow(/is reserved/)
		}
	})
})

describe("strayListeners", () => {
	it("flags a run's listener on a port it never claimed", () => {
		const ss = [
			'LISTEN 0 128 127.0.0.1:8545 0.0.0.0:* users:(("anvil",pid=2761590,fd=9))',
			'LISTEN 0 511 *:30418 *:* users:(("node",pid=2761564,fd=43))',
			'LISTEN 0 511 *:20365 *:* users:(("node",pid=2761564,fd=44))',
		].join("\n")
		expect(strayListeners(parseListeners(ss), [26938, 30418, 20365, 28901])).toEqual([
			{ pid: 2761590, address: "127.0.0.1:8545", port: 8545 },
		])
	})
})
