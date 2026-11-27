/**
 * Child processes this package starts and stops by ownership: each one leads its own process group
 * and `stop` signals that group alone, so another agent's servers on the same host are never touched.
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { endGroup } from "@pp/run-isolation/process-group"

export const APP_ROOT = fileURLToPath(new URL("..", import.meta.url))
const STOP_GRACE_MS = 10_000

export interface Group {
	readonly pid: number
	/** The leader's exit code; `null` when a signal ended it. */
	readonly exited: Promise<number | null>
	/** Everything the group wrote, when started with `capture`. */
	output(): string
	/** SIGTERM to the group, SIGKILL after a grace period; rejects if a member still runs after that. */
	stop(): Promise<void>
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
			if (!(await endGroup(pid, STOP_GRACE_MS))) throw new Error(`process group ${pid} outlived SIGKILL`)
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
