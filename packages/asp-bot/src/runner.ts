import type { TickResult } from "./loop"
import { encodeRecord, type PostNowReply, type ReadyEvent } from "./protocol"

/** A tick runs on each new Aztec block, on `post-now`, and at least this often. */
export const IDLE_TICK_MS = 30_000

export type RunnerDeps = {
	tick(postNow: boolean): Promise<TickResult>
	/** The node's latest Aztec block number. */
	blockNumber(): Promise<number>
	/** The ready event once `/latest` serves, else `null`. */
	readiness(): Omit<ReadyEvent, "event"> | null
	emit(event: ReadyEvent | PostNowReply): void
	now(): number
}

/** Schedules ticks. `step` must not be called again before its previous call settles. */
export class Runner {
	private lastBlock = -1
	private lastTick = Number.NEGATIVE_INFINITY
	private readonly queue: number[] = []
	private announced = false

	constructor(private readonly d: RunnerDeps) {}

	postNow(id: number): void {
		this.queue.push(id)
	}

	async step(): Promise<void> {
		const block = await this.d.blockNumber().catch(() => this.lastBlock)
		const id = this.queue.shift()
		if (id === undefined && block === this.lastBlock && this.d.now() - this.lastTick < IDLE_TICK_MS) return
		this.lastBlock = block
		this.lastTick = this.d.now()
		const r = await this.d.tick(id !== undefined)
		if (id !== undefined) {
			this.d.emit(
				r.post
					? { event: "post-now", id, ok: true, record: encodeRecord({ ...r.args }) }
					: { event: "post-now", id, ok: false, reason: r.reason },
			)
		}
		const ready = this.announced ? null : this.d.readiness()
		if (ready) {
			this.announced = true
			this.d.emit({ event: "ready", ...ready })
		}
	}
}
