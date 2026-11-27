/** Runs the real CLIs as a rehearsal does: separate processes, stdin closed, one JSON event per stdout line. */
import { spawn } from "node:child_process"
import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { killGroup, type OwnedChild, spawnOwned } from "@pp/run-isolation/process"
import { groupMembers } from "@pp/run-isolation/process-group"

const CLI = fileURLToPath(new URL("../cli/", import.meta.url))

export type Event = Record<string, unknown> & { event: string }
export type CliRun = { code: number | null; out: string; events: Event[] }

export function eventsOf(out: string): Event[] {
	const events: Event[] = []
	for (const line of out.split("\n")) {
		if (!line.startsWith("{")) continue
		try {
			const v = JSON.parse(line) as { event?: unknown }
			if (typeof v.event === "string") events.push(v as Event)
		} catch {
			// a progress line that happens to start with a brace
		}
	}
	return events
}

/** Runs `name` to completion; stdout and stderr together, in arrival order. */
export function runCli(name: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [`${CLI}${name}.ts`, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
		let out = ""
		child.stdout.on("data", (b) => (out += b))
		child.stderr.on("data", (b) => (out += b))
		child.on("error", reject)
		child.on("close", (code) => resolve({ code, out, events: eventsOf(out) }))
	})
}

/** Starts a long-running CLI as its own process group, logging to `logFile`. */
export const startCli = (name: string, args: readonly string[], env: NodeJS.ProcessEnv, logFile: string): OwnedChild =>
	spawnOwned(process.execPath, [`${CLI}${name}.ts`, ...args], logFile, env)

/** Waits for `event` (a name, or a test of each event with `what` naming it) in a long-running CLI's log; fails as soon as the child exits. */
export async function untilEvent(
	logFile: string,
	event: string | { what: string; test: (e: Event) => boolean },
	child: OwnedChild,
	timeoutMs: number,
): Promise<Event> {
	const deadline = Date.now() + timeoutMs
	const { what, test } = typeof event === "string" ? { what: event, test: (e: Event) => e.event === event } : event
	for (;;) {
		const found = eventsOf(readFileSync(logFile, "utf8")).find(test)
		if (found) return found
		if (child.hasExited()) throw new Error(`${what} never came: the process ended (${child.exitReason()})`)
		if (Date.now() > deadline) throw new Error(`${what} did not come within ${timeoutMs} ms`)
		await new Promise((r) => setTimeout(r, 500))
	}
}

/**
 * How a CLI from {@link startCli} ended, read from its log once it exits; past `timeoutMs` its group is
 * killed and this rejects.
 */
export async function ended(child: OwnedChild, logFile: string, timeoutMs: number): Promise<CliRun> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), timeoutMs)))
	const outcome = await Promise.race([child.exited, late])
	clearTimeout(timer)
	if (outcome === "late") {
		await killGroup(child)
		throw new Error(`${logFile} did not end within ${timeoutMs} ms`)
	}
	const out = readFileSync(logFile, "utf8")
	const code = /^exit code (\d+)$/.exec(child.exitReason() ?? "")?.[1]
	return { code: code === undefined ? null : Number(code), out, events: eventsOf(out) }
}

const socketInodes = (pid: number): Set<string> => {
	const out = new Set<string>()
	let fds: string[] = []
	try {
		fds = readdirSync(`/proc/${pid}/fd`)
	} catch {
		return out
	}
	for (const fd of fds) {
		try {
			const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)
			if (m?.[1]) out.add(m[1])
		} catch {
			// the descriptor closed while we read
		}
	}
	return out
}

/** Every TCP port a process of group `pgid` listens on, from `/proc` (Linux). */
export function listeningPorts(pgid: number): number[] {
	const inodes = new Set(groupMembers(pgid).flatMap((m) => [...socketInodes(m.pid)]))
	const ports = new Set<number>()
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		for (const row of readFileSync(table, "utf8").split("\n").slice(1)) {
			const f = row.trim().split(/\s+/)
			// columns: sl local_address rem_address st … inode (index 9); st 0A is LISTEN
			if (f[3] === "0A" && f[9] && inodes.has(f[9])) ports.add(Number.parseInt(f[1]?.split(":")[1] ?? "", 16))
		}
	}
	return [...ports].sort((a, b) => a - b)
}
