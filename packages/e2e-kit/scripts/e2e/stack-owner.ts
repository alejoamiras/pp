/**
 * The process group a state dir's `stack.pid` records, and whether it is still the one that dir
 * started. A pgid is an identity only while some member holds it, so the record also keeps the
 * leader's start time, which a process that later gets the same pid cannot share.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { endGroup, groupAlive, type ProcFs } from "@pp/run-isolation/process-group"

const HOST: ProcFs = { readdir: (path) => readdirSync(path), readFile: (path) => readFileSync(path, "utf8") }

/**
 * `pid`'s start time (field 22 of `/proc/<pid>/stat`) as text to compare exactly, a zombie's included;
 * undefined once the process is gone. Replaced by `@pp/run-isolation/process-group`'s `startTime` once that export exists.
 */
export function startTime(pid: number, proc: ProcFs = HOST): string | undefined {
	let stat: string
	try {
		stat = proc.readFile(`/proc/${pid}/stat`)
	} catch {
		return undefined
	}
	// The command name may hold spaces and ")"; field 22 is the 20th after the name's last ")".
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
}

export interface GroupRecord {
	pgid: number
	start: string
}

/**
 * Records `pgid` with its leader's start time. Call it before the spawner awaits anything: until the
 * event loop reaps the child, no other process can hold its pid.
 */
export function recordGroup(path: string, pgid: number, proc: ProcFs = HOST): void {
	const start = startTime(pgid, proc)
	if (start === undefined && startTime(process.pid, proc) === undefined)
		throw new Error(
			"stack: this machine has no /proc, so up cannot record the group it starts; stack mode runs only where /proc exists",
		)
	if (start === undefined) throw new Error(`stack: pid ${pgid} exited before its start time was read; see stack.log`)
	writeFileSync(path, `${pgid} ${start}\n`)
}

function readRecord(path: string): GroupRecord | undefined {
	const [pgid, start, ...rest] = readFileSync(path, "utf8").trim().split(" ")
	const n = Number(pgid)
	return Number.isSafeInteger(n) && n > 1 && start && rest.length === 0 ? { pgid: n, start } : undefined
}

/** Whether `r.pgid` is still led by the recorded process, running `cli`. */
export function ownedBy(r: GroupRecord, cli: string, proc: ProcFs = HOST): boolean {
	if (startTime(r.pgid, proc) !== r.start) return false
	try {
		return proc.readFile(`/proc/${r.pgid}/cmdline`).split("\0").includes(cli)
	} catch {
		return false
	}
}

/**
 * Ends the group `path` records while it is the one recorded, then drops the record, as it does once
 * that group is gone. A live group led by anything else, and an unreadable record, are left alone.
 */
export async function stopRecorded(path: string, cli: string, graceMs: number): Promise<void> {
	if (!existsSync(path)) return console.log("[e2e] no stack to stop")
	const r = readRecord(path)
	if (r === undefined) return console.log(`[e2e] ${path} is not a record this kit writes; leaving it`)
	if (ownedBy(r, cli)) {
		console.log(`[e2e] stopping the stack (pgid ${r.pgid})`)
		if (!(await endGroup(r.pgid, graceMs))) throw new Error(`stack: pgid ${r.pgid} survived SIGKILL`)
	} else if (groupAlive(r.pgid)) {
		return console.log(`[e2e] pgid ${r.pgid} is no longer the stack this state dir started; leaving it and ${path}`)
	} else console.log(`[e2e] the stack this state dir started is gone (pgid ${r.pgid})`)
	rmSync(path, { force: true })
}
