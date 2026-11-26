import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertSocketRoom, runLeftovers, SANDBOX_TMP_ROOT } from "./local-network"

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
