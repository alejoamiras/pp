import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"

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
	let reason: string | undefined
	const exited = new Promise<void>((resolve) => {
		child.once("exit", (code, signal) => {
			reason = signal ? `killed by ${signal}` : `exit code ${code}`
			resolve()
		})
		// Without a pid there is no process, and so no exit event: the spawn itself failed.
		child.on("error", (err) => {
			if (child.pid !== undefined) return
			reason = `could not start ${cmd}: ${err.message}`
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

/**
 * Signals only the group this module created. A child that already exited is left alone: the kernel
 * may have reused its PID, and so its group, for a stranger.
 */
export async function killGroup(owned: OwnedChild): Promise<void> {
	const pid = owned.child.pid
	if (pid === undefined || owned.hasExited()) return
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig)
		} catch {}
	}
	signal("SIGTERM")
	await exitedWithin(owned, 5_000)
	if (owned.hasExited()) return
	signal("SIGKILL")
	await exitedWithin(owned, 5_000)
	if (!owned.hasExited()) throw new Error(`process group ${pid} survived SIGKILL`)
}

const RPC_TIMEOUT_MS = 5_000

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	})
	const body = (await res.json()) as { result?: T; error?: { message: string } }
	if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`)
	return body.result
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Polls `probe` until it holds; a probe still pending at the deadline counts as a failure. */
export async function waitFor(
	label: string,
	probe: () => Promise<boolean>,
	timeoutMs: number,
	exitReason?: () => string | undefined,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const reason = exitReason?.()
		if (reason) throw new Error(`${label} ended before it became ready: ${reason}`)
		const ready = await Promise.race([probe().catch(() => false), sleep(deadline - Date.now()).then(() => false)])
		if (ready) return
		await sleep(250)
	}
	throw new Error(`${label} did not become ready within ${timeoutMs} ms`)
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
		void step().catch((err) => console.warn("[pp-env] a cleanup step pushed after teardown failed", err))
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
