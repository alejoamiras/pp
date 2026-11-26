/**
 * Child processes this package starts and stops by ownership: each one leads its own process group
 * and `stop` signals that group alone, so another agent's servers on the same host are never touched.
 */
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { mkdirSync, mkdtempSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const APP_ROOT = fileURLToPath(new URL("..", import.meta.url))
const STOP_GRACE_MS = 10_000

export interface Group {
	readonly pid: number
	/** The leader's exit code; `null` when a signal ended it. */
	readonly exited: Promise<number | null>
	/** Everything the group wrote, when started with `capture`. */
	output(): string
	/** SIGTERM to the group, SIGKILL after a grace period; resolves once no member is left. */
	stop(): Promise<void>
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0)
		return true
	} catch {
		return false
	}
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal)
	} catch {
		// The group is already gone.
	}
}

export function startGroup(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {}): Group {
	const child = spawn(cmd, args, {
		cwd: o.cwd ?? APP_ROOT,
		env: o.env ?? process.env,
		detached: true,
		stdio: o.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	})
	const pid = child.pid
	if (pid === undefined) throw new Error(`could not start ${cmd}`)
	let out = ""
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString()
	})
	child.stderr?.on("data", (chunk: Buffer) => {
		out += chunk.toString()
	})
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
	return {
		pid,
		exited,
		output: () => out,
		async stop() {
			signalGroup(pid, "SIGTERM")
			const deadline = Date.now() + STOP_GRACE_MS
			while (groupAlive(pid) && Date.now() < deadline) await sleep(100)
			if (groupAlive(pid)) signalGroup(pid, "SIGKILL")
			while (groupAlive(pid)) await sleep(50)
		},
	}
}

/** `bun run <args>` in the app root, as its own group: how the kit itself runs `vite`. */
export function bunRun(args: string[], o: { env?: NodeJS.ProcessEnv; capture?: boolean } = {}): Group {
	return startGroup(process.execPath, ["run", ...args], o)
}

/** A fresh directory under `~/.cache/pp/web/`: real disk, never `/tmp`. */
export function scratchDir(label: string): string {
	const base = join(homedir(), ".cache", "pp", "web")
	mkdirSync(base, { recursive: true })
	return mkdtempSync(join(base, `${label}-`))
}

/** The environment with every `PP_*` variable removed, so a child sees only what a caller adds. */
export function envWithout(prefix = "PP_"): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith(prefix)))
}
