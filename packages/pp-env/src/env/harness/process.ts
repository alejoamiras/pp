import { type ChildProcess, spawn } from "node:child_process"
import { createWriteStream, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** A spawned group leader plus the one authority on whether it still runs: its own exit event. */
export interface OwnedChild {
	child: ChildProcess
	hasExited: () => boolean
	exited: Promise<void>
}

/**
 * Spawns `cmd` as a new process-group leader with both streams drained to `logFile`.
 * An undrained pipe fills its kernel buffer and blocks the child silently.
 */
export function spawnOwned(cmd: string, args: string[], logFile: string, env: Record<string, string>): OwnedChild {
	mkdirSync(dirname(logFile), { recursive: true })
	const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env })
	const sink = createWriteStream(logFile, { flags: "a" })
	child.stdout?.on("data", (d: Buffer) => sink.write(d))
	child.stderr?.on("data", (d: Buffer) => sink.write(d))
	child.once("close", () => sink.end())
	let done = false
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => {
			done = true
			resolve()
		})
	})
	return { child, hasExited: () => done, exited }
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

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	})
	const body = (await res.json()) as { result?: T; error?: { message: string } }
	if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`)
	return body.result
}

export async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs: number, abort?: () => boolean): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (abort?.()) throw new Error(`${label} exited before it became ready`)
		if (await probe().catch(() => false)) return
		await new Promise((r) => setTimeout(r, 250))
	}
	throw new Error(`${label} did not become ready within ${timeoutMs} ms`)
}

const live = new Set<CleanupStack>()
let hooked = false

/**
 * Children are their own group leaders, so they outlive a parent killed by a signal unless it reaps
 * them: SIGINT/SIGTERM run every live cleanup and then re-raise.
 */
function hookSignals(): void {
	if (hooked) return
	hooked = true
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.once(sig, () => {
			void Promise.allSettled([...live].map((c) => c.run())).finally(() => process.kill(process.pid, sig))
		})
	}
}

/** Calls the async cleanups in reverse registration order; every one runs even if an earlier one throws. */
export class CleanupStack {
	private readonly steps: (() => Promise<void>)[] = []
	private running: Promise<void> | undefined

	constructor() {
		hookSignals()
		live.add(this)
	}

	push(step: () => Promise<void>): void {
		this.steps.push(step)
	}

	run(): Promise<void> {
		live.delete(this)
		this.running ??= (async () => {
			const errors: unknown[] = []
			for (const step of this.steps.reverse()) {
				try {
					await step()
				} catch (err) {
					errors.push(err)
				}
			}
			if (errors.length > 0) throw new AggregateError(errors, "cleanup failed")
		})()
		return this.running
	}
}
