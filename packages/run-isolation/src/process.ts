import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import { groupAlive, groupGone, signalGroup } from "./process-group"

/** A spawned group leader plus the one authority on whether it still runs: its own exit or spawn error. */
export interface OwnedChild {
	child: ChildProcess
	/** Undefined while the child runs; afterwards how it ended. */
	exitReason: () => string | undefined
	hasExited: () => boolean
	exited: Promise<void>
}

/**
 * Spawns `cmd` as a new process-group leader writing both streams straight to `logFile`. A command
 * that cannot start ends `exited` with a reason instead of an uncaught `error` event.
 */
export function spawnOwned(cmd: string, args: string[], logFile: string, env: Record<string, string>): OwnedChild {
	mkdirSync(dirname(logFile), { recursive: true })
	const log = openSync(logFile, "a", 0o600)
	let child: ChildProcess
	try {
		child = spawn(cmd, args, { stdio: ["ignore", log, log], detached: true, env })
	} finally {
		closeSync(log)
	}
	return own(child)
}

/** Tracks a child spawned with `detached: true`. A child that cannot start ends `exited` with a reason instead of an uncaught `error`. */
export function own(child: ChildProcess): OwnedChild {
	let reason: string | undefined
	const exited = new Promise<void>((resolve) => {
		child.once("exit", (code, signal) => {
			reason = signal ? `killed by ${signal}` : `exit code ${code}`
			resolve()
		})
		// Without a pid there is no process, and so no exit event: the spawn itself failed.
		child.on("error", (err) => {
			if (child.pid !== undefined) return
			reason = `could not start ${child.spawnfile}: ${err.message}`
			resolve()
		})
	})
	return { child, exitReason: () => reason, hasExited: () => reason !== undefined, exited }
}

function exitedWithin(owned: OwnedChild, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		void owned.exited.then(() => {
			clearTimeout(timer)
			resolve()
		})
	})
}

/** EPERM still means the pid exists, held by another user. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * Whether `-pid` still names the group `owned` leads. After the leader exits, a running member keeps
 * the number reserved, so a running group whose number names no process is still this one; a process
 * holding the number got it after the group ended and is a stranger. Assumes the number is not handed
 * out again, and its new group orphaned, within one run.
 */
export function ownsGroup(owned: OwnedChild): boolean {
	const pid = owned.child.pid
	if (pid === undefined) return false
	return !owned.hasExited() || (groupAlive(pid) && !processExists(pid))
}

/**
 * Ends the group `owned` leads and nothing else: SIGTERM while the leader runs, then SIGKILL to what is
 * still running in the group, since a member that ignores SIGTERM outlives its leader. Resolves with
 * whether the group is gone within `graceMs` of that SIGKILL.
 */
export async function killGroup(owned: OwnedChild, graceMs = 5_000): Promise<boolean> {
	const pid = owned.child.pid
	if (pid === undefined || !ownsGroup(owned)) return true
	const signal = (sig: NodeJS.Signals) => {
		if (signalGroup(pid, sig)) return
		// Before the child's setsid the group does not exist yet; the leader still takes the signal.
		try {
			owned.child.kill(sig)
		} catch {}
	}
	if (!owned.hasExited()) {
		signal("SIGTERM")
		await exitedWithin(owned, graceMs)
	}
	if (!ownsGroup(owned)) return true
	signal("SIGKILL")
	return groupGone(pid, graceMs)
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const
const live = new Set<CleanupStack>()
let hooked = false
let shuttingDown = false

/**
 * Children are their own group leaders, so they outlive a parent killed by a signal unless it reaps
 * them: the first SIGINT/SIGTERM runs every live cleanup, including any already under way, and then
 * re-raises. Repeats are ignored so they cannot kill the parent mid-teardown.
 */
function onSignal(sig: NodeJS.Signals): void {
	if (shuttingDown) return
	shuttingDown = true
	void Promise.allSettled([...live].map((c) => c.run())).finally(() => {
		for (const s of SIGNALS) process.removeListener(s, onSignal)
		process.kill(process.pid, sig)
	})
}

function hookSignals(): void {
	if (hooked) return
	hooked = true
	for (const sig of SIGNALS) process.on(sig, onSignal)
}

/** Calls the async cleanups in reverse registration order; every one runs even if an earlier one throws. */
export class CleanupStack {
	private readonly steps: (() => Promise<void>)[] = []
	private running: Promise<void> | undefined
	private settled = false

	/** With `signals: false` the owner tears down; nothing here reacts to SIGINT or SIGTERM. */
	constructor(o: { signals?: boolean } = {}) {
		if (o.signals === false) return
		hookSignals()
		live.add(this)
	}

	/** Startup may still be finishing a spawn when teardown starts: a late step runs next, or at once if teardown is over. */
	push(step: () => Promise<void>): void {
		if (!this.settled) {
			this.steps.push(step)
			return
		}
		void step().catch((err) => console.warn("a cleanup step pushed after teardown failed", err))
	}

	/** Idempotent; the stack stays visible to the signal handler until every step has settled. */
	run(): Promise<void> {
		this.running ??= (async () => {
			const errors: unknown[] = []
			for (let step = this.steps.pop(); step; step = this.steps.pop()) {
				try {
					await step()
				} catch (err) {
					errors.push(err)
				}
			}
			this.settled = true
			live.delete(this)
			if (errors.length > 0) throw new AggregateError(errors, "cleanup failed")
		})()
		return this.running
	}
}
