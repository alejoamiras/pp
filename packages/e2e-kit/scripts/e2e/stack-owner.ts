/**
 * The process group a state dir's `stack.pid` records, and whether it is still the one that dir
 * started. A pgid is an identity only while some member holds it, so the record also keeps the
 * leader's start time, which a process that later gets the same pid cannot share, and the
 * `pidNamespace` token under which that pid and start time name one process.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { endGroup, groupAlive, type ProcFs, pidNamespace, startTime } from "@pp/run-isolation/process-group"
import { type OwnedPorts, portLeftovers } from "./owned"

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

/** What `stack.pid` holds once `stopStack` saw the group gone but its check failed: no pid left to resolve. */
const GONE = "gone"

function readRecord(path: string): GroupRecord | typeof GONE | undefined {
	const text = readFileSync(path, "utf8").trim()
	if (text === GONE) return GONE
	const [pgid, start, namespace, ...rest] = text.split(" ")
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
	if (b.recorded) {
		await stopRecorded(path, b.cli, b.graceMs)
		return
	}
	if (b.unreaped && !(await endGroup(pgid, b.graceMs))) throw new Error(`stack: pgid ${pgid} survived SIGKILL`)
}

/** What `stopRecorded` found: no record, a record it could not resolve to this dir's group, or that group gone. */
export type StopOutcome = "absent" | "unresolved" | "gone"

/**
 * Ends the group `path` records while it is the one recorded. A live group led by anything else, an
 * unreadable record and one from another pid namespace are left alone, and so is the record. Once the
 * group is gone the record is dropped, unless `keepRecord` leaves that to a caller that checks more.
 */
export async function stopRecorded(path: string, cli: string, graceMs: number, keepRecord = false): Promise<StopOutcome> {
	const unresolved = (why: string): StopOutcome => {
		console.log(`[e2e] ${why}; leaving it`)
		return "unresolved"
	}
	if (!existsSync(path)) {
		console.log("[e2e] no stack to stop")
		return "absent"
	}
	const r = readRecord(path)
	if (r === undefined) return unresolved(`${path} is not a record this kit writes`)
	if (r === GONE) {
		console.log("[e2e] the stack this state dir started is already gone")
		if (!keepRecord) rmSync(path, { force: true })
		return "gone"
	}
	if (r.namespace !== pidNamespace()) return unresolved(`${path} was written under another boot or pid namespace`)
	if (ownedBy(r, cli)) {
		console.log(`[e2e] stopping the stack (pgid ${r.pgid})`)
		if (!(await endGroup(r.pgid, graceMs))) throw new Error(`stack: pgid ${r.pgid} survived SIGKILL`)
	} else if (groupAlive(r.pgid)) {
		return unresolved(`pgid ${r.pgid} is no longer the stack this state dir started, and ${path} stays`)
	} else console.log(`[e2e] the stack this state dir started is gone (pgid ${r.pgid})`)
	if (!keepRecord) rmSync(path, { force: true })
	return "gone"
}

/** The CLI's own line when `stack.stop()` throws (local-stack's `cli.ts`), which its exit status alone would carry. */
const TEARDOWN_FAILED = /^\[stack\] teardown failed:/m

export interface StackFiles {
	pid: string
	/** The snapshot `up` writes once the stack is ready; absent when the boot never got that far. */
	owned: string
	log: string
}

/**
 * `stopRecorded`, then, once this dir's group is gone, a check that the CLI reported no teardown
 * failure and that no port in the snapshot is still held: the CLI's teardown can fail, or end under
 * SIGKILL, and leave its services' listeners or registry rows behind its group. Leftovers get up to
 * `settleMs` to clear, since a service's watcher ends its group and releases its rows after the CLI
 * dies. The record is dropped only once the check passes; until then it says the group is gone, so a
 * later `down` checks the ports again without resolving a pid the kernel may have handed out since.
 * Throws on an unresolved record or a failed check, naming each leftover.
 */
export async function stopStack(f: StackFiles, cli: string, graceMs: number, settleMs: number): Promise<void> {
	const first = existsSync(f.pid) && readFileSync(f.pid, "utf8").trim() !== GONE
	const outcome = await stopRecorded(f.pid, cli, graceMs, true)
	if (outcome === "absent") return
	if (outcome === "unresolved") throw new Error(`stack: ${f.pid} names no group this kit can stop, so the teardown is unverified`)
	const left = existsSync(f.owned) ? await settledLeftovers(JSON.parse(readFileSync(f.owned, "utf8")) as OwnedPorts, settleMs) : []
	// The CLI's report fails the first `down` only; a later one has only the ports left to check.
	if (first && existsSync(f.log) && TEARDOWN_FAILED.test(readFileSync(f.log, "utf8")))
		left.unshift(`the CLI reported a failed teardown (${f.log})`)
	if (left.length === 0) return rmSync(f.pid, { force: true })
	writeFileSync(f.pid, `${GONE}\n`)
	throw new Error(`stack: its group is gone, but ${left.join("; ")}`)
}

async function settledLeftovers(o: OwnedPorts, settleMs: number): Promise<string[]> {
	for (const end = Date.now() + settleMs; ; await new Promise((r) => setTimeout(r, 250))) {
		const left = portLeftovers(o)
		if (left.length === 0 || Date.now() >= end) return left
	}
}
