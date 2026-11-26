export type HeartbeatOptions = {
	/** Tick spacing; ticks are fixed from the start, not from the previous beat's end. */
	intervalMs: number
	/** One beat. It gets no timeout: the node keeps a request the client gave up on, so a retry would build a second block. */
	beat(signal: AbortSignal): Promise<void>
	/** Skips a tick when it resolves false; omitted, every free tick beats. */
	due?(): Promise<boolean>
	/** A beat still open after this long is logged as late. */
	slowMs: number
	/** How long `stop` waits for an open beat after aborting it. */
	stopWaitMs: number
	log(line: string): void
}

export interface Heartbeat {
	/** Idempotent: clears the timer, aborts an open beat and waits at most `stopWaitMs` for it. */
	stop(): Promise<void>
	readonly beats: number
	readonly failuresInARow: number
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Beats on fixed ticks. A tick that finds the previous beat still open is skipped, so beats never
 * overlap: a beat longer than one interval moves the next to the first tick after it returns.
 */
export function startHeartbeat(o: HeartbeatOptions): Heartbeat {
	let open: Promise<void> | undefined
	let inFlight: AbortController | undefined
	let beats = 0
	let failuresInARow = 0
	let stopping: Promise<void> | undefined

	const run = async () => {
		const ac = new AbortController()
		inFlight = ac
		const started = performance.now()
		const late = setTimeout(() => o.log(`[stack] heartbeat beat open for ${o.slowMs / 1000} s`), o.slowMs)
		try {
			if ((o.due && !(await o.due())) || ac.signal.aborted) return
			await o.beat(ac.signal)
			beats++
			failuresInARow = 0
		} catch (err) {
			if (ac.signal.aborted) return
			failuresInARow++
			o.log(
				`[stack] heartbeat beat failed after ${((performance.now() - started) / 1000).toFixed(1)} s (${failuresInARow} in a row): ${message(err)}`,
			)
		} finally {
			clearTimeout(late)
			inFlight = undefined
		}
	}
	const timer = setInterval(() => {
		if (open || stopping) return
		open = run().finally(() => {
			open = undefined
		})
	}, o.intervalMs)

	return {
		stop() {
			stopping ??= (async () => {
				clearInterval(timer)
				inFlight?.abort()
				if (!open) return
				let waited: ReturnType<typeof setTimeout> | undefined
				const giveUp = new Promise<void>((resolve) => {
					waited = setTimeout(resolve, o.stopWaitMs)
				})
				await Promise.race([open, giveUp])
				clearTimeout(waited)
			})()
			return stopping
		},
		get beats() {
			return beats
		},
		get failuresInARow() {
			return failuresInARow
		},
	}
}
