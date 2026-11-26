import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertSocketRoom, killGroup, own, runLeftovers, SANDBOX_CACHE_DIR, SANDBOX_TMP_ROOT, startLocalNetwork } from "./local-network"

const freshRunId = (label: string) => `${label}-${randomBytes(4).toString("hex")}`

async function eventually(check: () => boolean, ms = 3_000): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (check()) return true
	return check()
}

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
			expect(await eventually(() => runLeftovers(run).length === 0)).toBe(true)
		} finally {
			try {
				process.kill(-pgid, "SIGKILL")
			} catch {}
		}
	})
})

describe("startLocalNetwork", () => {
	it("releases its claimed ports when a later step fails, and installs no signal handler when told not to", async () => {
		const root = mkdtempSync(join(tmpdir(), "pp-toolchain-"))
		for (const bin of ["bin/aztec-anvil", "node_modules/.bin/aztec", "internal-bin/forge", "internal-bin/anvil"]) {
			mkdirSync(dirname(join(root, bin)), { recursive: true })
			writeFileSync(join(root, bin), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
		}
		// A regular file where the run's data directory needs a parent: creating it fails after the claim.
		mkdirSync(SANDBOX_CACHE_DIR, { recursive: true })
		const blocker = join(SANDBOX_CACHE_DIR, freshRunId("start-test-blocker"))
		writeFileSync(blocker, "")
		const runId = `${basename(blocker)}/run`
		const handlers = process.listenerCount("SIGTERM")
		try {
			await expect(startLocalNetwork({ runId, toolchainRoot: root, signals: false })).rejects.toThrow(/ENOTDIR|not a directory/)
			expect(process.listenerCount("SIGTERM")).toBe(handlers)
			expect(runLeftovers({ runId, dirs: [], pgids: [] })).toEqual([])
		} finally {
			rmSync(root, { recursive: true, force: true })
			rmSync(blocker, { force: true })
		}
	})
})
