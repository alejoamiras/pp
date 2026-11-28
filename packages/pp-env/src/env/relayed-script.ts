import { spawn } from "node:child_process"
import { closeSync, openSync, readFileSync } from "node:fs"
import { CleanupStack, killGroup, type OwnedChild, own } from "@pp/run-isolation/process"
import { journalTo } from "../send-log.ts"
import type { SendPath, SendPathOptions } from "../send-path.ts"
import { type RelayTuning, type SendRelay, startSendRelay } from "../send-relay.ts"
import { tail } from "./tools.ts"

export type RelayedScriptOptions = RelayTuning & {
	/** The send log, named in a failure; a shared `path` must already write to it. */
	journalPath: string
	/** No new receipt for this long ends the script's process group; default 10 minutes. */
	noReceiptMs?: number
} & (
		| {
				/** A path the caller owns and closes, shared with what it sends after the script; it reads from `readUrl`. */
				path: SendPath
		  }
		| Omit<SendPathOptions, "readUrl" | "journal">
	)

type RunRelayedOptions = {
	readUrl: string
	cmd: (rpcUrl: string) => string[]
	cwd: string
	/** The command's whole environment; no other process is handed it. */
	env: Record<string, string>
	logFile: string
	relay: RelayedScriptOptions
}

function failure(why: string, relay: SendRelay, o: RelayedScriptOptions, out: string): Error {
	const last = relay.failures().at(-1)
	const refused = last ? `; the last send not admitted: ${last.message}` : ""
	return new Error(`forge script ${why}; ${relay.landed()} transactions landed${refused}; send log ${o.journalPath}\n${tail(out)}`)
}

function startRelay(o: RunRelayedOptions): Promise<SendRelay> {
	const { journalPath, noReceiptMs: _, ...relay } = o.relay
	if (!("path" in relay)) return startSendRelay({ ...relay, readUrl: o.readUrl, journal: journalTo(journalPath) })
	if (relay.path.o.readUrl !== o.readUrl) throw new Error("the shared send path reads from another endpoint than the script")
	return startSendRelay(relay)
}

/**
 * Runs `cmd(url)` with `url` a loopback {@link startSendRelay} over `readUrl` that listens before the
 * command starts and stops when it exits. The command is spawned directly, so it alone receives `env`, and
 * leads a process group of its own. That group is ended, and its end awaited, when the relay serves no new
 * receipt for `noReceiptMs` or this process takes SIGINT or SIGTERM. A process killed outright takes the
 * relay with it, so the command's next call finds nothing listening. Nothing is restarted or resumed.
 * @returns the command's combined output, from `logFile`
 * @throws Error on a non-zero exit or a stall, naming how many transactions landed and the last send not
 *   admitted, followed by the relay's own stop failure if there was one; else Error for that failure alone
 */
export async function runRelayed(o: RunRelayedOptions): Promise<string> {
	const relay = await startRelay(o)
	let out: string
	try {
		out = await supervise(o, relay)
	} catch (e) {
		throw await stoppedWith(e as Error, relay)
	}
	await relay.stop()
	return out
}

/** `e`, followed by the relay's stop failure if it has one, so neither hides the other. */
async function stoppedWith(e: Error, relay: SendRelay): Promise<Error> {
	try {
		await relay.stop()
		return e
	} catch (stop) {
		return new Error(`${e.message}\nThen: ${(stop as Error).message}`, { cause: e })
	}
}

function spawnScript(bin: string, args: string[], o: RunRelayedOptions): OwnedChild {
	const fd = openSync(o.logFile, "a", 0o600)
	try {
		return own(spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", fd, fd] }))
	} finally {
		closeSync(fd)
	}
}

/** Runs the command to its end under the no-receipt deadline; the group is gone when this settles. */
async function supervise(o: RunRelayedOptions, relay: SendRelay): Promise<string> {
	const [bin, ...args] = o.cmd(relay.url)
	if (!bin) throw new Error("no command to run")
	const child = spawnScript(bin, args, o)
	// The group outlives a signal to this process unless this ends it: the stack runs on SIGINT and SIGTERM.
	const teardown = new CleanupStack()
	let survived = false
	teardown.push(async () => {
		survived = !(await killGroup(child))
	})
	const limit = o.relay.noReceiptMs ?? 600_000
	let stalled = false
	const timer = setInterval(
		() => {
			if (stalled || Date.now() - relay.lastProgressAt() < limit) return
			stalled = true
			void teardown.run().catch(() => {})
		},
		Math.min(5_000, limit / 4),
	)
	await child.exited
	clearInterval(timer)
	await teardown.run()
	const out = readFileSync(o.logFile, "utf8")
	const kept = survived ? " (a member of its group survived SIGKILL)" : ""
	if (stalled) throw failure(`saw no new receipt for ${limit / 1000} s, so its process group was ended${kept}`, relay, o.relay, out)
	if (child.exitReason() !== "exit code 0") throw failure(`ended with ${child.exitReason()}${kept}`, relay, o.relay, out)
	if (survived) throw failure(`exited, but${kept}`, relay, o.relay, out)
	return out
}
