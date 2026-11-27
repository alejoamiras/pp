/** What `up` reads from local-stack's CLI log, and the wait for it. */
import { existsSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

/** The rest of the line, so a directory holding spaces survives. */
const CIRCUITS = /^\[stack\] circuits (.+)$/m
/** The ready line through its end, so a manifest path holding spaces survives too. */
const READY = /^\[stack\] ready in .* PP_STACK_MANIFEST=(.+)$/m
const SEEDED = /pool user (0x[0-9a-fA-F]{40})\b.*bridge sender (0x[0-9a-fA-F]{40})\b/

export interface StackLog {
	/** The pool checkout's circuit builds, which the app's server serves. */
	circuitsDir?: string
	manifestPath?: string
	seeded?: { user: string; sender: string }
}

export function parseStackLog(text: string): StackLog {
	const circuitsDir = text.match(CIRCUITS)?.[1]
	const manifestPath = text.match(READY)?.[1]
	const seeded = text.match(SEEDED)
	return {
		...(circuitsDir ? { circuitsDir } : {}),
		...(manifestPath ? { manifestPath } : {}),
		...(seeded?.[1] && seeded[2] ? { seeded: { user: seeded[1], sender: seeded[2] } } : {}),
	}
}

export interface ReadyOptions {
	readyMs?: number
	/** How long after the ready line the seeded line may lag; the CLI prints them back to back. */
	seededGraceMs?: number
	pollMs?: number
}

export interface ReadyStack {
	circuitsDir: string
	manifestPath: string
	user: string
	sender: string
}

/**
 * The ready stack once the log holds it, undefined while it may still. Throws at a ready line with no
 * circuits line before it, and once the seeded line lags the ready one by more than `graceMs`.
 */
function settled(s: StackLog, msSinceReady: number, graceMs: number, log: string): ReadyStack | undefined {
	if (!s.manifestPath) return undefined
	if (!s.circuitsDir) throw new Error(`stack: the CLI logged ready but no circuits directory; see ${log}`)
	if (s.seeded) return { circuitsDir: s.circuitsDir, manifestPath: s.manifestPath, ...s.seeded }
	if (msSinceReady > graceMs) throw new Error(`stack: the CLI logged ready but no seeded accounts within ${graceMs / 1000} s; see ${log}`)
	return undefined
}

/** Resolves once the log holds the circuits, ready and seeded lines while the CLI runs; rejects as `settled` does, once the CLI has exited, or after `readyMs`. */
export async function untilReady(log: string, exited: () => number | null, o: ReadyOptions = {}): Promise<ReadyStack> {
	const { readyMs = 20 * 60_000, seededGraceMs = 5_000, pollMs = 1_000 } = o
	let readyAt: number | undefined
	for (const end = Date.now() + readyMs; Date.now() < end; await sleep(pollMs)) {
		// Read before the log: an exited CLI never resolves ready, even one whose log already says so.
		const code = exited()
		const s = parseStackLog(existsSync(log) ? readFileSync(log, "utf8") : "")
		if (code !== null) throw new Error(`stack: the CLI exited (${code}) before it was ready; see ${log}`)
		if (s.manifestPath) readyAt ??= Date.now()
		const ready = settled(s, readyAt === undefined ? 0 : Date.now() - readyAt, seededGraceMs, log)
		if (ready) return ready
	}
	throw new Error(`stack: not ready within ${readyMs / 60_000} min; see ${log}`)
}
