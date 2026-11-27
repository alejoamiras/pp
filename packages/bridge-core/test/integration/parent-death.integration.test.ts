import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { releaseRows, rowsOwnedBy } from "@pp/run-isolation/ports"
import { groupGone, signalGroup } from "@pp/run-isolation/process-group"
import { afterAll, describe, expect, it } from "vitest"
import { INTEGRATION } from "./sandbox"

const LOCAL_NETWORK = fileURLToPath(new URL("../../scripts/sandbox/local-network.ts", import.meta.url))

// A host that boots the network and then holds, with nothing of its own to tear it down.
const HOST = `import { startLocalNetwork } from ${JSON.stringify(LOCAL_NETWORK)}
await startLocalNetwork({ runId: process.argv[2], signals: false })
console.log("READY")
setInterval(() => {}, 1_000)
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

describe.skipIf(!INTEGRATION || !existsSync("/proc/self/stat"))("a sandbox whose host dies", () => {
	const runId = `bridge-parent-death-${process.pid}-${Date.now().toString(36)}`
	let host: ChildProcess | undefined
	let work: string | undefined
	let pgids: number[] = []
	let output = ""
	afterAll(async () => {
		host?.kill("SIGKILL")
		for (const pgid of pgids) signalGroup(pgid, "SIGKILL")
		await releaseRows(runId)
		// A SIGKILLed host removes none of its directories.
		const dirs = /, data (\S+), tmp (\S+)/.exec(output)?.slice(1) ?? []
		for (const dir of [...dirs, ...(work ? [work] : [])]) rmSync(dir, { recursive: true, force: true })
	})

	it("ends both of its process groups and frees every row it claimed when SIGKILLed", async () => {
		const parent = join(homedir(), ".cache/pp/bridge-core")
		mkdirSync(parent, { recursive: true })
		work = mkdtempSync(join(parent, "parent-death-"))
		const script = join(work, "host.ts")
		writeFileSync(script, HOST)
		const child = spawn("bun", [script, runId], { stdio: ["ignore", "pipe", "inherit"] })
		host = child
		const exited = new Promise((resolve) => child.once("exit", resolve))
		await new Promise<void>((resolve, reject) => {
			child.stdout.on("data", (d: Buffer) => {
				output += d.toString()
				if (output.includes("READY")) resolve()
			})
			child.once("exit", (code, signal) =>
				reject(new Error(`the host exited (${signal ?? code}) before the network was up:\n${output}`)),
			)
		})
		pgids = ledGroups(child.pid as number)
		expect(pgids).toHaveLength(2)
		expect(rowsOwnedBy(runId)).toBe(4)

		const killed = Date.now()
		child.kill("SIGKILL")
		await exited
		for (const pgid of pgids) expect(await groupGone(pgid, 60_000)).toBe(true)
		console.log(`[parent-death] both groups gone ${Date.now() - killed} ms after the host's SIGKILL`)
		// A leader frees its rows before it exits, and only once it has seen its group empty.
		expect(rowsOwnedBy(runId)).toBe(0)
	}, 360_000)
})
