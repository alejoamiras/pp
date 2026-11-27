import { spawn } from "node:child_process"
import { closeSync, openSync, readFileSync } from "node:fs"
import { killGroup, type OwnedChild, own } from "@pp/run-isolation/process"
import { journalTo } from "../send-path.ts"
import { type SendRelay, type SendRelayOptions, startSendRelay } from "../send-relay.ts"
import { tail } from "./tools.ts"

export type RelayedScriptOptions = Omit<SendRelayOptions, "readUrl" | "journal"> & {
	/** Where every send's hash, nonce and each endpoint answer are appended as JSON lines. */
	journalPath: string
	/** No new receipt for this long ends the script's process group; default 10 minutes. */
	noReceiptMs?: number
}

function failure(why: string, relay: SendRelay, o: RelayedScriptOptions, out: string): Error {
	const last = relay.failures().at(-1)
	const refused = last ? `; the last send not admitted: ${last.message}` : ""
	return new Error(`forge script ${why}; ${relay.landed()} transactions landed${refused}; send log ${o.journalPath}\n${tail(out)}`)
}

/**
 * Runs `cmd(url)` with `url` a loopback {@link startSendRelay} over `readUrl` that listens before the
 * command starts and stops when it exits. The command leads a process group of its own, which is ended
 * when the relay serves no new receipt for `noReceiptMs`. Nothing is restarted or resumed.
 * @returns the command's combined output, from `logFile`
 * @throws Error on a non-zero exit or a stall, naming how many transactions landed and the last send not admitted
 */
export async function runRelayed(o: {
	readUrl: string
	cmd: (rpcUrl: string) => string[]
	cwd: string
	env: Record<string, string>
	logFile: string
	relay: RelayedScriptOptions
}): Promise<string> {
	const relay = await startSendRelay({ ...o.relay, readUrl: o.readUrl, journal: journalTo(o.relay.journalPath) })
	try {
		const [bin, ...args] = o.cmd(relay.url)
		if (!bin) throw new Error("no command to run")
		const fd = openSync(o.logFile, "a", 0o600)
		let child: OwnedChild
		try {
			child = own(spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", fd, fd] }))
		} finally {
			closeSync(fd)
		}
		const limit = o.relay.noReceiptMs ?? 600_000
		let stalled = false
		const timer = setInterval(
			() => {
				if (stalled || Date.now() - relay.lastProgressAt() < limit) return
				stalled = true
				void killGroup(child)
			},
			Math.min(5_000, limit / 4),
		)
		await child.exited
		clearInterval(timer)
		const out = readFileSync(o.logFile, "utf8")
		if (stalled) throw failure(`saw no new receipt for ${limit / 1000} s, so its process group was ended`, relay, o.relay, out)
		if (child.exitReason() !== "exit code 0") throw failure(`ended with ${child.exitReason()}`, relay, o.relay, out)
		return out
	} finally {
		await relay.stop()
	}
}
