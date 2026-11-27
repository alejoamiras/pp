import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

const PROC = existsSync("/proc/self/stat")

/** The `/proc` reads this module makes, passed in so a test can script a race the kernel won't schedule on demand. */
export interface ProcFs {
	/** Entry names of a directory; throws once it is gone. */
	readdir(path: string): string[]
	/** A file's text; throws once it is gone. */
	readFile(path: string): string
}

/** The `/proc` reads `pidNamespace` makes: files and symbolic links. */
export interface ProcLinks extends ProcFs {
	/** A symbolic link's target; throws if it is missing. */
	readlink(path: string): string
	exists(path: string): boolean
}

const HOST: ProcLinks = {
	readdir: (path) => readdirSync(path),
	readFile: (path) => readFileSync(path, "utf8"),
	readlink: (path) => readlinkSync(path),
	exists: (path) => existsSync(path),
}

/** Passes over a zombie-only group before membership that never settles reads as a member still forking. */
const SCANS = 8

const signalable = (pgid: number) => {
	try {
		process.kill(-pgid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

const exited = (state: string | undefined) => state === undefined || state === "Z" || state === "X"

/** State, process group and start time from a `/proc` stat file, or undefined once it is gone. */
function readStat(path: string, proc: ProcFs): { state?: string; pgrp: number; start?: string } | undefined {
	let stat: string
	try {
		stat = proc.readFile(path)
	} catch {
		return undefined
	}
	// The command name may hold spaces and parentheses; after its last ")" come state (field 3), ppid,
	// pgrp, and later starttime (field 22).
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
	return { state: fields[0], pgrp: Number(fields[2]), start: fields[19] }
}

/**
 * The threads `/proc` lists for `pid`, and whether one has not exited: a leader whose own thread exited
 * reads as a zombie while its other threads still run.
 */
function threadsOf(pid: string, proc: ProcFs): { running: boolean; tids: string[] } {
	let tids: string[]
	try {
		tids = proc.readdir(`/proc/${pid}/task`)
	} catch {
		return { running: false, tids: [] }
	}
	return { running: tids.some((tid) => !exited(readStat(`/proc/${pid}/task/${tid}/stat`, proc)?.state)), tids }
}

/**
 * The start time of `pid` (`/proc` stat field 22, clock ticks since boot) while `/proc` lists it, a
 * zombie included; undefined once it is gone, and always without `/proc`. A pid and its start time name
 * one process under one `pidNamespace` token, since a pid handed out again starts later.
 */
export function startTime(pid: number, proc: ProcFs = HOST): string | undefined {
	return PROC ? readStat(`/proc/${pid}/stat`, proc)?.start : undefined
}

/**
 * Through an ancestor pid namespace's `/proc`, `NSpid` lists this process once per level, so equal numbers
 * at two levels cannot pass for this namespace's own `/proc`.
 */
function procNumbersOwnNamespace(proc: ProcLinks): boolean {
	const pids = /^NSpid:\s+(.+)$/m.exec(proc.readFile("/proc/self/status"))?.[1]?.trim().split(/\s+/)
	return pids?.length === 1 && pids[0] === String(process.pid)
}

/** A `/proc` mounted with `hidepid` hides live processes, so a missing pid there proves nothing. */
function procHidesPids(proc: ProcLinks): boolean {
	// An overmount is listed after the mount it covers, so the last `/proc` line is the one in effect.
	const mount = proc
		.readFile("/proc/self/mountinfo")
		.split("\n")
		.findLast((line) => line.split(" ")[4] === "/proc")
	const options = mount?.split(" - ")[1]?.split(" ")[2] ?? ""
	return options.split(",").some((o) => o.startsWith("hidepid=") && !/^hidepid=(0|off)$/.test(o))
}

/**
 * The token under which a pid and its `startTime` name one process: this boot, pid namespace and time
 * namespace (which offsets field 22 for its readers). Undefined when `/proc` cannot vouch that a pid it
 * does not list is gone: no `/proc`, a `/proc` that numbers another pid namespace than this process's,
 * or one mounted with `hidepid`. Another container sharing a directory has another token.
 */
export function pidNamespace(proc: ProcLinks = HOST): string | undefined {
	if (!PROC) return undefined
	try {
		if (!procNumbersOwnNamespace(proc) || procHidesPids(proc)) return undefined
		const boot = proc.readFile("/proc/sys/kernel/random/boot_id").trim()
		const time = proc.exists("/proc/self/ns/time") ? proc.readlink("/proc/self/ns/time") : ""
		return `${boot}/${proc.readlink("/proc/self/ns/pid")}/${time}`
	} catch {
		return undefined
	}
}

/** Every process in `pgid` with its state and command line (`[]` without `/proc`), for a log line. */
export function groupMembers(pgid: number, proc: ProcFs = HOST): { pid: number; state: string; args: string }[] {
	if (!PROC) return []
	const members: { pid: number; state: string; args: string }[] = []
	for (const pid of proc.readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue
		const st = readStat(`/proc/${pid}/stat`, proc)
		if (st?.pgrp !== pgid) continue
		let args = ""
		try {
			args = proc.readFile(`/proc/${pid}/cmdline`).replaceAll("\0", " ").trim().slice(0, 200)
		} catch {}
		const state = st.state ?? "?"
		members.push({
			pid: Number(pid),
			state: exited(st.state) && threadsOf(pid, proc).running ? `${state}, threads running` : state,
			args,
		})
	}
	return members
}

/**
 * One pass over `/proc`: whether a member of `pgid` has a thread that has not exited, else the members it
 * listed with their listed threads. A thread that exits is gone before its stat is read, so the listing,
 * not the stats, is what a later pass compares.
 */
function scanGroup(pgid: number, proc: ProcFs): { running: boolean; members: string } {
	const members: string[] = []
	for (const pid of proc.readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue
		const st = readStat(`/proc/${pid}/stat`, proc)
		if (st?.pgrp !== pgid) continue
		if (!exited(st.state)) return { running: true, members: "" }
		const threads = threadsOf(pid, proc)
		if (threads.running) return { running: true, members: "" }
		members.push(`${pid}:${threads.tids.sort().join(",")}`)
	}
	return { running: false, members: members.sort().join(" ") }
}

/**
 * Whether some process in `pgid` has a thread that has not exited, read from `/proc`. A pass misses a
 * child forked, or a thread started, after it was listed by a creator that exits before the pass reads
 * it, so a pass that finds only zombies is repeated until two in a row list the same members and threads.
 */
function hasRunningMember(pgid: number, proc: ProcFs): boolean {
	let last: string | undefined
	for (let i = 0; i < SCANS; i++) {
		const { running, members } = scanGroup(pgid, proc)
		if (running) return true
		if (members === last) return false
		last = members
	}
	return true
}

/**
 * Whether a member of the group is still running. Where `/proc` exists, a zombie (exited, but not yet
 * reaped by whatever adopted it, which a slow subreaper can delay) counts as gone unless one of its
 * threads still runs; elsewhere the group counts while the kernel still lets it be signalled. Known
 * limit: a pgid is only an identity while some member, even a zombie, holds it.
 */
export function groupAlive(pgid: number, proc: ProcFs = HOST): boolean {
	return signalable(pgid) && (!PROC || hasRunningMember(pgid, proc))
}

/** Sends `s` to every member of `pgid`; false when the kernel refused it (no such group, or not ours to signal). */
export function signalGroup(pgid: number, s: NodeJS.Signals): boolean {
	try {
		process.kill(-pgid, s)
		return true
	} catch {
		return false
	}
}

/** Resolves once no member of `pgid` is running, or after `ms`; whether the group is gone. */
export async function groupGone(pgid: number, ms: number, proc: ProcFs = HOST): Promise<boolean> {
	for (const end = Date.now() + ms; groupAlive(pgid, proc) && Date.now() < end; ) await sleep(50)
	return !groupAlive(pgid, proc)
}

async function escalate(pgid: number, graceMs: number, proc: ProcFs): Promise<boolean> {
	if (!groupAlive(pgid, proc)) return true
	signalGroup(pgid, "SIGTERM")
	if (await groupGone(pgid, graceMs, proc)) return true
	signalGroup(pgid, "SIGKILL")
	return groupGone(pgid, graceMs, proc)
}

const ending = new Map<number, Promise<boolean>>()

/**
 * SIGTERM to the group, then SIGKILL to whatever is left after `graceMs`; resolves with whether the
 * group is gone. Calls while one is under way share it, so no member gets SIGTERM twice.
 */
export function endGroup(pgid: number, graceMs: number, proc: ProcFs = HOST): Promise<boolean> {
	let p = ending.get(pgid)
	if (!p) {
		p = escalate(pgid, graceMs, proc).finally(() => ending.delete(pgid))
		ending.set(pgid, p)
	}
	return p
}
