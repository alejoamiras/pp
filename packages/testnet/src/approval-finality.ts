/**
 * The bot's log, read for approval finality. The standalone bot skips a tick with `asp_root_mismatch`
 * whenever the ASP's leaves do not build the registry's root at its `finalized` block. A latest-only
 * ASP serves the leaves of an approval as soon as its root is published, so leaves that build the
 * registry's root at `latest` mean the bot is waiting for that root to finalize, not that it is broken.
 */

type Fields = Record<string, unknown>
export type BotLog = (event: string, fields?: Fields) => void

export type FinalityIo = {
	/** The registry's `latestASPRoot()` at `latest`. */
	latestRoot(): Promise<bigint>
	report(event: string, fields: Record<string, string | number | bigint | boolean>): void
	now(): number
}

/** One ASP root the bot could not match: the first and last tick that said so, and whether `latest` explains it. */
type Wait = { first: number; last: number; explained: boolean; reading: boolean }

/**
 * Wraps `inner`. A mismatch whose ASP root is the registry's root at `latest` is reported once as
 * `approval-finality-wait`; the post that then carries that root reports `approval-finality-reached` with
 * the milliseconds between the first and the last mismatch for it. A mismatch `latest` does not explain
 * reports nothing beyond `inner`'s line, and a failed read is retried at the next mismatch.
 */
export function approvalFinalityLog(io: FinalityIo, inner: BotLog): BotLog {
	const waits = new Map<bigint, Wait>()
	const classify = (aspRoot: bigint, chainRoot: unknown, w: Wait) => {
		w.reading = true
		void io.latestRoot().then(
			(latest) => {
				w.reading = false
				if (latest !== aspRoot || w.explained) return
				w.explained = true
				io.report("approval-finality-wait", { chainRoot: String(chainRoot), aspRoot })
			},
			() => {
				w.reading = false
			},
		)
	}
	const mismatch = (f: Fields) => {
		if (typeof f.aspRoot !== "bigint") return
		const now = io.now()
		const w = waits.get(f.aspRoot) ?? { first: now, last: now, explained: false, reading: false }
		w.last = now
		waits.set(f.aspRoot, w)
		if (!w.explained && !w.reading) classify(f.aspRoot, f.chainRoot, w)
	}
	const posted = (f: Fields) => {
		const w = typeof f.poolRoot === "bigint" ? waits.get(f.poolRoot) : undefined
		if (w?.explained)
			io.report("approval-finality-reached", {
				poolRoot: f.poolRoot as bigint,
				sequence: String(f.sequence),
				waitedMs: w.last - w.first,
			})
		waits.clear()
	}
	return (event, fields = {}) => {
		inner(event, fields)
		if (event === "asp_root_mismatch") mismatch(fields)
		else if (event === "posted") posted(fields)
	}
}
