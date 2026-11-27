#!/usr/bin/env bun
/**
 * Stands in for `bun run demo --keep` in with-stack's tests: prints the run id, makes the run
 * directory with-stack checks for residue, then either fails before ready (`early-exit`) or prints
 * the manifest line and holds until SIGINT, removing the directory unless told to leak it.
 * Usage: `bun fake-stack.ts <runId> <ready|early-exit|leak>`.
 */
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const [runId, mode] = process.argv.slice(2)
if (!runId || !mode) process.exit(2)
const dir = join(homedir(), ".cache", "pp", "runs", runId)
mkdirSync(dir, { recursive: true })
console.log(`[stack] run ${runId} pid ${process.pid}`)
if (mode === "early-exit") process.exit(1)
process.on("SIGINT", () => {
	if (mode !== "leak") rmSync(dir, { recursive: true, force: true })
	process.exit(130)
})
console.log(`[stack] ready in 0 s — PP_STACK_MANIFEST=${join(dir, "manifest.json")}`)
setInterval(() => {}, 1 << 30)
