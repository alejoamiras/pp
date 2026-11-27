/** What `up` reads from local-stack's CLI log, and the wait for it. */
import { existsSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

const RUN = /^\[stack\] run \S+ pid (\d+)$/m
const READY = /PP_STACK_MANIFEST=(\S+)/
const SEEDED = /pool user (0x[0-9a-fA-F]{40})\b.*bridge sender (0x[0-9a-fA-F]{40})\b/

export interface StackLog {
	/** The pid the CLI logged as its own. */
	pid?: string
	manifestPath?: string
	seeded?: { user: string; sender: string }
}

export function parseStackLog(text: string): StackLog {
	const pid = text.match(RUN)?.[1]
	const manifestPath = text.match(READY)?.[1]
	const seeded = text.match(SEEDED)
	return {
		...(pid ? { pid } : {}),
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

/**
 * Resolves once the log holds the ready and seeded lines. Rejects if the CLI exits first, if the
 * seeded line has not matched `seededGraceMs` after the ready line did, or after `readyMs`.
 */
export async function untilReady(
	log: string,
	exited: () => number | null,
	o: ReadyOptions = {},
): Promise<{ manifestPath: string; user: string; sender: string }> {
	const { readyMs = 20 * 60_000, seededGraceMs = 5_000, pollMs = 1_000 } = o
	let readyAt: number | undefined
	for (const end = Date.now() + readyMs; Date.now() < end; await sleep(pollMs)) {
		const { manifestPath, seeded } = parseStackLog(existsSync(log) ? readFileSync(log, "utf8") : "")
		if (manifestPath && seeded) return { manifestPath, ...seeded }
		if (manifestPath) readyAt ??= Date.now()
		if (readyAt !== undefined && Date.now() - readyAt > seededGraceMs)
			throw new Error(`stack: the CLI logged ready but no seeded accounts within ${seededGraceMs / 1000} s; see ${log}`)
		const code = exited()
		if (code !== null) throw new Error(`stack: the CLI exited (${code}) before it was ready; see ${log}`)
	}
	throw new Error(`stack: not ready within ${readyMs / 60_000} min; see ${log}`)
}
