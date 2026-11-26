// Child processes owned by one run: each is its own process-group leader and is stopped by group, never by name.
import { type ChildProcess, spawn } from "node:child_process"
import { createWriteStream, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"

export const TOOLCHAIN = process.env.AZTEC_HOME ?? join(homedir(), ".aztec", "versions", "6.0.0")
export const CACHE_ROOT = join(homedir(), ".cache", "pp", "aztec-spikes")

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function newRunId(kind: string): string {
	return `spk-${kind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

/** A per-run directory on real disk; a tmpfs store killed mid-run stays pinned in RAM. */
export function runDir(runId: string): string {
	const dir = join(CACHE_ROOT, runId)
	mkdirSync(join(dir, "tmp"), { recursive: true })
	return dir
}

export function removeRunDir(runId: string): void {
	rmSync(join(CACHE_ROOT, runId), { recursive: true, force: true })
}

/** Both streams go to a log file: an unread pipe fills and silently stalls the child. */
export function spawnGroup(cmd: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): ChildProcess {
	const child = spawn(cmd, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
	const log = createWriteStream(logFile, { flags: "a" })
	child.stdout?.pipe(log)
	child.stderr?.pipe(log)
	return child
}

function alive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0)
		return true
	} catch {
		return false
	}
}

export async function killGroup(child: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
	const pgid = child?.pid
	if (!pgid || !alive(pgid)) return
	try {
		process.kill(-pgid, "SIGTERM")
	} catch {}
	for (let waited = 0; waited < graceMs; waited += 100) {
		await sleep(100)
		if (!alive(pgid)) return
	}
	killGroupSync(child)
}

/**
 * Synchronous last resort for an `exit` hook, which cannot await. Signals only a group that still exists: once it is
 * gone, its id can be reused by another run's process.
 */
export function killGroupSync(child: ChildProcess | undefined): void {
	const pgid = child?.pid
	if (!pgid || !alive(pgid)) return
	try {
		process.kill(-pgid, "SIGKILL")
	} catch {}
}

export async function waitTcp(port: number, timeoutMs: number, child?: ChildProcess): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child && child.exitCode !== null) throw new Error(`process exited with ${child.exitCode} before listening on ${port}`)
		const up = await new Promise<boolean>((res) => {
			const s = connect(port, "127.0.0.1")
			s.once("connect", () => {
				s.destroy()
				res(true)
			})
			s.once("error", () => res(false))
		})
		if (up) return
		await sleep(250)
	}
	throw new Error(`nothing listened on ${port} within ${timeoutMs} ms`)
}
