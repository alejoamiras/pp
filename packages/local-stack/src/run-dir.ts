import { randomBytes } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const RUNS_DIR = join(homedir(), ".cache", "pp", "runs")

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
 * Creates `<runsDir>/<runId>` holding this process's `pid`, which tells a live stack's manifest from
 * one a crashed stack left behind. Returns the directory.
 */
export async function createRunDir(runsDir: string, runId: string): Promise<string> {
	const dir = join(runsDir, runId)
	await mkdir(dir, { recursive: true })
	await writeAtomic(join(dir, "pid"), `${process.pid}\n`)
	return dir
}

/** Idempotent. */
export async function removeRunDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}
