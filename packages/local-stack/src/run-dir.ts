import { randomBytes } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const RUNS_DIR = join(homedir(), ".cache", "pp", "runs")

export const newRunId = () => `stack-${process.pid}-${Date.now().toString(36)}`

/**
 * One path segment, short enough that pp-env's `-pool` id stays inside its 64 characters. Both
 * harnesses release registry rows by owner id, so no run id may end in `-pool`: a stack `x-pool`
 * would own the rows of stack `x`'s pool.
 */
const RUN_ID = /^(?!.*-pool$)[a-z0-9][a-z0-9-]{0,47}$/

/** Writes through a sibling temp file and `rename`, so a reader sees the old content or the new, never a prefix. */
export async function writeAtomic(path: string, text: string): Promise<void> {
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`
	try {
		await writeFile(tmp, text, { flag: "wx" })
		await rename(tmp, path)
	} catch (err) {
		await rm(tmp, { force: true })
		throw err
	}
}

/**
 * Creates `<runsDir>/<runId>` holding this process's `pid`: a manifest whose pid is dead was left by
 * a crashed stack (a live pid may have been recycled). Returns the directory.
 * @throws Error when `runId` is malformed, or when the directory exists: the run id belongs to
 *   another stack, live or crashed.
 */
export async function createRunDir(runsDir: string, runId: string): Promise<string> {
	if (!RUN_ID.test(runId)) throw new Error(`runId ${JSON.stringify(runId)} must match ${RUN_ID}`)
	const dir = join(runsDir, runId)
	await mkdir(runsDir, { recursive: true })
	try {
		await mkdir(dir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
		throw new Error(`run dir ${dir} exists: run id ${runId} belongs to another stack, or a crashed one left it`)
	}
	try {
		await writeAtomic(join(dir, "pid"), `${process.pid}\n`)
	} catch (err) {
		await removeRunDir(dir)
		throw err
	}
	return dir
}

/** Idempotent. */
export async function removeRunDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}
