/**
 * The process group a state dir's `stack.pid` records, and whether it is still the one that dir
 * started. A pgid is an identity only while some member holds it, so the record also keeps the
 * leader's start time, which a process that later gets the same pid cannot share, and the
 * `pidNamespace` token under which that pid and start time name one process.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { endGroup, groupAlive, type ProcFs, pidNamespace, startTime } from "@pp/run-isolation/process-group"

const HOST: ProcFs = { readdir: (path) => readdirSync(path), readFile: (path) => readFileSync(path, "utf8") }

export interface GroupRecord {
	pgid: number
	start: string
	namespace: string
}

/**
 * Records `pgid` with its leader's start time. Call it before the spawner awaits anything: until the
 * event loop reaps the child, no other process can hold its pid.
 */
export function recordGroup(path: string, pgid: number, proc: ProcFs = HOST, namespace = pidNamespace): void {
	const start = startTime(pgid, proc)
	if (start === undefined && startTime(process.pid, proc) === undefined)
		throw new Error(
			"stack: this machine has no /proc, so up cannot record the group it starts; stack mode runs only where /proc exists",
		)
	const ns = namespace()
	if (ns === undefined)
		throw new Error("stack: this /proc hides processes or numbers another pid namespace, so up cannot record the group it starts")
	if (start === undefined) throw new Error(`stack: pid ${pgid} exited before its start time was read; see stack.log`)
	writeFileSync(path, `${pgid} ${start} ${ns}\n`)
}

function readRecord(path: string): GroupRecord | undefined {
	const [pgid, start, namespace, ...rest] = readFileSync(path, "utf8").trim().split(" ")
	const n = Number(pgid)
	return Number.isSafeInteger(n) && n > 1 && start && namespace && rest.length === 0 ? { pgid: n, start, namespace } : undefined
}

/**
 * Whether `r.pgid` is still the recorded group, read under the record's namespace: led by the recorded
 * process (running `cli`, or a zombie, whose cmdline reads empty), or leaderless and still running,
 * since a member holding the number keeps the kernel from handing it out as a pid. Assumes the number
 * is not reused for a new group that is itself orphaned while this record stands.
 */
export function ownedBy(r: GroupRecord, cli: string, proc: ProcFs = HOST, namespace = pidNamespace): boolean {
	if (namespace() !== r.namespace) return false
	const start = startTime(r.pgid, proc)
	if (start === undefined) return groupAlive(r.pgid, proc)
	if (start !== r.start) return false
	try {
		const args = proc.readFile(`/proc/${r.pgid}/cmdline`)
		return args === "" || args.split("\0").includes(cli)
	} catch {
		return false
	}
}

export interface FailedBoot {
	/** Whether `recordGroup` wrote the record. */
	recorded: boolean
	/** Whether the spawner has not yet reaped the CLI, so no other process can hold its pid. */
	unreaped: boolean
	cli: string
	graceMs: number
}

/**
 * Tears down a boot that failed. Once the record is written only `stopRecorded` may end the group: the
 * CLI can have exited and been reaped, and its pgid can then name a stranger. Without a record, the
 * group is ended only while the CLI is unreaped. Throws if a group it signals survives.
 */
export async function abandonBoot(path: string, pgid: number, b: FailedBoot): Promise<void> {
	if (b.recorded) return stopRecorded(path, b.cli, b.graceMs)
	if (b.unreaped && !(await endGroup(pgid, b.graceMs))) throw new Error(`stack: pgid ${pgid} survived SIGKILL`)
}

/**
 * Ends the group `path` records while it is the one recorded, then drops the record, as it does once
 * that group is gone. A live group led by anything else, and an unreadable record, are left alone.
 */
export async function stopRecorded(path: string, cli: string, graceMs: number): Promise<void> {
	if (!existsSync(path)) return console.log("[e2e] no stack to stop")
	const r = readRecord(path)
	if (r === undefined) return console.log(`[e2e] ${path} is not a record this kit writes; leaving it`)
	if (r.namespace !== pidNamespace()) return console.log(`[e2e] ${path} was written under another boot or pid namespace; leaving it`)
	if (ownedBy(r, cli)) {
		console.log(`[e2e] stopping the stack (pgid ${r.pgid})`)
		if (!(await endGroup(r.pgid, graceMs))) throw new Error(`stack: pgid ${r.pgid} survived SIGKILL`)
	} else if (groupAlive(r.pgid)) {
		return console.log(`[e2e] pgid ${r.pgid} is no longer the stack this state dir started; leaving it and ${path}`)
	} else console.log(`[e2e] the stack this state dir started is gone (pgid ${r.pgid})`)
	rmSync(path, { force: true })
}
