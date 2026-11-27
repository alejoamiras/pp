import { readFileSync } from "node:fs"
import { killGroup, type OwnedChild, spawnOwned } from "@pp/run-isolation/process"
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
 * command starts and stops when it exits. The command runs in a watched process group of its own, which
 * ends with this process however it dies, and is ended when the relay serves no new receipt for
 * `noReceiptMs`. Nothing is restarted or resumed.
 * @returns the command's combined output, from `logFile`
 * @throws Error on a non-zero exit or a stall, naming how many transactions landed and the last send not
 *   admitted; else Error when the relay's port row could not be dropped
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
	let out: string
	try {
		out = await supervise(o, relay)
	} catch (e) {
		await relay.stop().catch(() => {})
		throw e
	}
	await relay.stop()
	return out
}

/** Runs the command to its end under the no-receipt deadline; the group is gone when this settles. */
async function supervise(o: Parameters<typeof runRelayed>[0], relay: SendRelay): Promise<string> {
	const [bin, ...args] = o.cmd(relay.url)
	if (!bin) throw new Error("no command to run")
	const child: OwnedChild = spawnOwned(bin, args, o.logFile, o.env, {}, o.cwd)
	const limit = o.relay.noReceiptMs ?? 600_000
	let stall: Promise<boolean> | undefined
	const timer = setInterval(
		() => {
			if (stall === undefined && Date.now() - relay.lastProgressAt() >= limit) stall = killGroup(child)
		},
		Math.min(5_000, limit / 4),
	)
	await child.exited
	clearInterval(timer)
	const gone = stall === undefined || (await stall)
	const out = readFileSync(o.logFile, "utf8")
	if (stall !== undefined)
		throw failure(
			`saw no new receipt for ${limit / 1000} s, so its process group was ended${gone ? "" : " (a member survived SIGKILL)"}`,
			relay,
			o.relay,
			out,
		)
	if (child.exitReason() !== "exit code 0") throw failure(`ended with ${child.exitReason()}`, relay, o.relay, out)
	return out
}
