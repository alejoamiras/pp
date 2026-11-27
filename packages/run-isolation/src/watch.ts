/**
 * The leader of a group `spawnWatched` starts: runs one command as its child, in this group, and ends
 * the group when the process that spawned it dies by any death. That parent holds the only other end of
 * fd 3, so the kernel closes it with the parent and a read here sees end-of-file.
 *
 * Argument: the JSON `WatchSpec`. While the parent lives this process only waits: the group's signals
 * reach the command directly, and this process exits as the command did once it has.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createReadStream, writeSync } from "node:fs"
import { Socket } from "node:net"
import { constants } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { type RowRef, releaseNamed } from "./ports.ts"
import { othersRunning } from "./process-group.ts"

export interface WatchSpec {
	cmd: string
	args: string[]
	/** The registry rows this group's ports hold, released once the group is seen empty after its parent died. */
	release: RowRef[]
	/** The registry those rows live in, fixed by the parent: the command's environment need not name it. */
	registry: string
	graceMs: number
}

const spec = JSON.parse(process.argv[2] ?? "") as WatchSpec
const parent = process.ppid

/** Synchronous, so it lands before an exit; a reader already gone is not this process's concern. */
const say = (line: string) => {
	try {
		writeSync(2, `${line}\n`)
	} catch {}
}

// A group signal reaches the command too; this process stays to report how the command ended.
const HELD = ["SIGTERM", "SIGINT", "SIGHUP"] as const
const hold = () => {}
for (const s of HELD) process.on(s, hold)

let orphaned = false
let child: ChildProcess
try {
	child = spawn(spec.cmd, spec.args, { stdio: "inherit" })
} catch (err) {
	say(`could not start ${spec.cmd}: ${(err as Error).message}`)
	process.exit(127)
}
child.on("error", (err) => {
	say(`could not start ${spec.cmd}: ${err.message}`)
	if (!orphaned) process.exit(127)
})
child.on("exit", (code, signal) => {
	// The parent may be dead with its end-of-file not read yet; the group still needs the orphan path.
	if (process.ppid !== parent) void parentGone()
	else if (!orphaned) mirror(code, signal)
})

/** Ends this process the way the command ended, so its spawner reads the command's exit. */
function mirror(code: number | null, signal: NodeJS.Signals | null): void {
	if (!signal) process.exit(code ?? 1)
	if ((HELD as readonly string[]).includes(signal)) process.off(signal, hold)
	process.kill(process.pid, signal)
	// A signal whose default this runtime ignores (SIGPIPE) never ends it: fall back to the shell's convention.
	setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 100)
}

/** Waits up to the grace for every other member to stop running. */
async function othersGone(): Promise<boolean> {
	for (const end = Date.now() + spec.graceMs; othersRunning(process.pid, process.pid) && Date.now() < end; ) await sleep(50)
	return !othersRunning(process.pid, process.pid)
}

/** Frees the named rows; a failure leaves them, and says which in the command's log. */
async function release(): Promise<boolean> {
	if (spec.release.length === 0) return true
	if (await releaseNamed(spec.release, spec.registry).catch(() => false)) return true
	const rows = spec.release.map((r) => `${r.service} ${r.port} (${r.owner})`).join(", ")
	say(`could not release ${rows} from ${spec.registry}; remove them by hand`)
	return false
}

async function parentGone(): Promise<void> {
	if (orphaned) return
	orphaned = true
	try {
		process.kill(0, "SIGTERM")
		// A port is free in the registry only once nothing in the group can still hold it.
		if (await othersGone()) process.exit((await release()) ? 0 : 1)
	} catch {}
	// Something outlived SIGTERM's grace (or there is no trustworthy /proc to tell): the whole group goes at
	// once, this leader with it, and the rows stay.
	process.kill(0, "SIGKILL")
}

// Node reads a file stream in its thread pool, where a read parked on this fd holds up process.exit for
// good; Bun's net.Socket never sees this fd's end-of-file. Each runtime gets the reader that works in it.
const watch = process.versions.bun ? createReadStream("", { fd: 3 }) : new Socket({ fd: 3, readable: true, writable: false })
watch.on("data", () => {})
watch.once("end", () => void parentGone())
watch.once("error", () => void parentGone())
