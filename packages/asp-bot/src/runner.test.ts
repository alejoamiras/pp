import { describe, expect, it } from "vitest"
import type { TickResult } from "./loop"
import { IDLE_TICK_MS, Runner } from "./runner"

describe("the runner", () => {
	it("ticks on a new block, on post-now and when idle, replies to post-now, and announces ready once", async () => {
		let block = 5
		let now = 0
		let serving = false
		const ticks: boolean[] = []
		const emitted: object[] = []
		let result: TickResult = { post: false, reason: "unchanged" }
		const r = new Runner({
			tick: async (postNow) => {
				ticks.push(postNow)
				return result
			},
			blockNumber: async () => block,
			readiness: () => (serving ? { url: "http://127.0.0.1:9", port: 9, poster: "0x0b", birthIntake: "0x0c" } : null),
			emit: (e) => emitted.push(e),
			now: () => now,
		})

		await r.step()
		await r.step()
		expect(ticks).toEqual([false])
		block = 6
		serving = true
		await r.step()
		await r.step()
		expect(ticks).toEqual([false, false])
		expect(emitted).toEqual([{ event: "ready", url: "http://127.0.0.1:9", port: 9, poster: "0x0b", birthIntake: "0x0c" }])

		r.postNow(1)
		await r.step()
		result = { post: true, args: { sequence: 2n, poolRoot: 3n, birthRoot: 0n, l1Block: 4n, rootTime: 5n } }
		r.postNow(2)
		await r.step()
		expect(ticks).toEqual([false, false, true, true])
		expect(emitted.slice(1)).toEqual([
			{ event: "post-now", id: 1, ok: false, reason: "unchanged" },
			{ event: "post-now", id: 2, ok: true, record: { sequence: "2", poolRoot: "3", birthRoot: "0", l1Block: "4", rootTime: "5" } },
		])

		now += IDLE_TICK_MS
		await r.step()
		expect(ticks).toHaveLength(5)
	})
})
