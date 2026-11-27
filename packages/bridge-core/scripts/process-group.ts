import { existsSync, readdirSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

const PROC = existsSync("/proc/self/stat")

const signalable = (pgid: number) => {
	try {
		process.kill(-pgid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

const exited = (state: string | undefined) => state === undefined || state === "Z" || state === "X"

/** State and process group from a `/proc` stat file, or undefined once it is gone. */
function readStat(path: string): { state?: string; pgrp: number } | undefined {
	let stat: string
	try {
		stat = readFileSync(path, "utf8")
	} catch {
		return undefined
	}
	// The command name may hold spaces and parentheses; after its last ")" come state, ppid, pgrp.
	const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
	return { state, pgrp: Number(pgrp) }
}

/** A leader whose own thread exited reads as a zombie while its other threads still run. */
function anyThreadRunning(pid: string): boolean {
	let tids: string[]
	try {
		tids = readdirSync(`/proc/${pid}/task`)
	} catch {
		return false
	}
	return tids.some((tid) => !exited(readStat(`/proc/${pid}/task/${tid}/stat`)?.state))
}

/** Whether some process in `pgid` has a thread that has not exited, read from `/proc`. */
function hasRunningMember(pgid: number): boolean {
	for (const pid of readdirSync("/proc")) {
		if (!/^\d+$/.test(pid)) continue
		const st = readStat(`/proc/${pid}/stat`)
		if (st?.pgrp !== pgid) continue
		if (!exited(st.state) || anyThreadRunning(pid)) return true
	}
	return false
}

/**
 * Whether a member of the group is still running. Where `/proc` exists, a zombie (exited, but not yet
 * reaped by whatever adopted it, which a slow subreaper can delay) counts as gone unless one of its
 * threads still runs; elsewhere the group counts while the kernel still lets it be signalled. Known
 * limit: a pgid is only an identity while some member, even a zombie, holds it.
 */
export function groupAlive(pgid: number): boolean {
	return signalable(pgid) && (!PROC || hasRunningMember(pgid))
}

const signalGroup = (pgid: number, s: NodeJS.Signals) => {
	try {
		process.kill(-pgid, s)
	} catch {}
}

/** Resolves once no member of `pgid` is running, or after `ms`; whether the group is gone. */
export async function groupGone(pgid: number, ms: number): Promise<boolean> {
	for (const end = Date.now() + ms; groupAlive(pgid) && Date.now() < end; ) await sleep(50)
	return !groupAlive(pgid)
}

async function escalate(pgid: number, graceMs: number): Promise<boolean> {
	if (!groupAlive(pgid)) return true
	signalGroup(pgid, "SIGTERM")
	if (await groupGone(pgid, graceMs)) return true
	signalGroup(pgid, "SIGKILL")
	return groupGone(pgid, graceMs)
}

const ending = new Map<number, Promise<boolean>>()

/**
 * SIGTERM to the group, then SIGKILL to whatever is left after `graceMs`; resolves with whether the
 * group is gone. Calls while one is under way share it, so no member gets SIGTERM twice.
 */
export function endGroup(pgid: number, graceMs: number): Promise<boolean> {
	let p = ending.get(pgid)
	if (!p) {
		p = escalate(pgid, graceMs).finally(() => ending.delete(pgid))
		ending.set(pgid, p)
	}
	return p
}
