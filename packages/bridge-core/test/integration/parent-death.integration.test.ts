import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { releaseRows, rowsOwnedBy } from "@pp/run-isolation/ports"
import { groupGone, signalGroup } from "@pp/run-isolation/process-group"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { INTEGRATION } from "./sandbox"

const LOCAL_NETWORK = fileURLToPath(new URL("../../scripts/sandbox/local-network.ts", import.meta.url))

// A host that boots the network, then holds with nothing of its own to tear it down, until a line on
// stdin makes it exit at once.
const HOST = `import { startLocalNetwork } from ${JSON.stringify(LOCAL_NETWORK)}
await startLocalNetwork({ runId: process.argv[2], signals: false })
process.stdin.once("data", () => process.exit(0))
console.log("READY")
`

/** The groups led by direct children of `parent`: one per watched spawn, its launcher the leader. */
function ledGroups(parent: number): number[] {
	const led: number[] = []
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue
		let stat: string
		try {
			stat = readFileSync(`/proc/${entry}/stat`, "utf8")
		} catch {
			continue
		}
		// After the command name: state, ppid, pgrp.
		const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
		if (Number(ppid) === parent && Number(pgrp) === Number(entry)) led.push(Number(entry))
	}
	return led
}

interface Run {
	runId: string
	host?: ChildProcess
	pgids: number[]
	output: string
}

/** Ends what a run left: its host, its groups (found from a host still running if boot never got that far),
 *  then its rows and directories once nothing in those groups can hold them. */
async function cleanUp(run: Run): Promise<void> {
	const host = run.host
	const hostRuns = host?.pid !== undefined && host.exitCode === null && host.signalCode === null
	if (run.pgids.length === 0 && hostRuns) run.pgids = ledGroups(host.pid as number)
	host?.kill("SIGKILL")
	for (const pgid of run.pgids) signalGroup(pgid, "SIGKILL")
	const gone = await Promise.all(run.pgids.map((pgid) => groupGone(pgid, 10_000)))
	// A member that outlived SIGKILL may still hold a port, so its rows stay, as its leader's would.
	if (gone.every(Boolean)) await releaseRows(run.runId)
	// The host never ran its teardown, so its directories are still there.
	for (const dir of /, data (\S+), tmp (\S+)/.exec(run.output)?.slice(1) ?? []) rmSync(dir, { recursive: true, force: true })
}

describe.skipIf(!INTEGRATION || !existsSync("/proc/self/stat"))("a sandbox whose host dies", () => {
	let work = ""
	let script = ""
	const runs: Run[] = []
	beforeAll(() => {
		const root = join(homedir(), ".cache/pp/bridge-core")
		mkdirSync(root, { recursive: true })
		work = mkdtempSync(join(root, "parent-death-"))
		script = join(work, "host.ts")
		writeFileSync(script, HOST)
	})
	afterAll(async () => {
		for (const run of runs) await cleanUp(run)
		if (work) rmSync(work, { recursive: true, force: true })
	})

	for (const death of ["SIGKILL", "process.exit"] as const) {
		it(`ends both of its process groups and frees every row it claimed, on ${death}`, async () => {
			const run: Run = { runId: `bridge-parent-death-${process.pid}-${Date.now().toString(36)}`, pgids: [], output: "" }
			runs.push(run)
			// Without the attach pair, from the environment or a .env, the host boots its own network rather
			// than reusing the suite's.
			const { SANDBOX_L1_RPC: _rpc, SANDBOX_NODE_URL: _node, ...env } = process.env
			const host = spawn("bun", ["--no-env-file", script, run.runId], { stdio: ["pipe", "pipe", "inherit"], env })
			run.host = host
			const exited = new Promise((resolve) => host.once("exit", resolve))
			await new Promise<void>((resolve, reject) => {
				host.stdout.on("data", (d: Buffer) => {
					run.output += d.toString()
					if (run.output.includes("READY")) resolve()
				})
				host.once("exit", (code, signal) =>
					reject(new Error(`the host exited (${signal ?? code}) before the network was up:\n${run.output}`)),
				)
			})
			run.pgids = ledGroups(host.pid as number)
			expect(run.pgids).toHaveLength(2)
			expect(rowsOwnedBy(run.runId)).toBe(4)

			const killed = Date.now()
			if (death === "SIGKILL") host.kill("SIGKILL")
			else host.stdin.write("exit\n")
			await exited
			for (const pgid of [...run.pgids]) {
				expect(await groupGone(pgid, 60_000)).toBe(true)
				// A gone group leaves cleanup: its number may already name someone else's.
				run.pgids = run.pgids.filter((p) => p !== pgid)
			}
			console.log(`[parent-death] both groups gone ${Date.now() - killed} ms after the host's ${death}`)
			// A leader frees its rows before it exits, and only once it has seen its group empty.
			expect(rowsOwnedBy(run.runId)).toBe(0)
		}, 360_000)
	}
})
