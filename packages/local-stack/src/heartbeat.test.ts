import { describe, expect, test } from "bun:test"
import { startHeartbeat } from "./heartbeat.ts"

const TICK = 20

describe("heartbeat", () => {
	test("a beat longer than a tick skips the tick it overlaps and never runs twice at once", async () => {
		const starts: number[] = []
		let openNow = 0
		let maxOpen = 0
		const t0 = performance.now()
		const hb = startHeartbeat({
			intervalMs: TICK,
			slowMs: 1_000,
			stopWaitMs: 1_000,
			log: () => {},
			beat: async () => {
				starts.push(performance.now() - t0)
				maxOpen = Math.max(maxOpen, ++openNow)
				await Bun.sleep(TICK * 1.3)
				openNow--
			},
		})
		await Bun.sleep(TICK * 9)
		await hb.stop()
		expect(maxOpen).toBe(1)
		const spacing = starts.slice(1).map((s, i) => s - (starts[i] ?? 0))
		expect(spacing.length).toBeGreaterThanOrEqual(2)
		for (const d of spacing) expect(d).toBeGreaterThan(TICK * 1.5)
	})

	test("counts failures in a row, resets on success, and honours due()", async () => {
		const lines: string[] = []
		const outcomes = [false, false, true]
		let dueCalls = 0
		const hb = startHeartbeat({
			intervalMs: TICK,
			slowMs: 1_000,
			stopWaitMs: 1_000,
			log: (l) => lines.push(l),
			due: async () => ++dueCalls % 2 === 1,
			beat: async () => {
				if (!(outcomes.shift() ?? true)) throw new Error("node down")
			},
		})
		await Bun.sleep(TICK * 8)
		await hb.stop()
		expect(lines.filter((l) => l.includes("node down")).map((l) => l.match(/\((\d) in a row\)/)?.[1])).toEqual(["1", "2"])
		expect(hb.beats).toBeGreaterThanOrEqual(1)
		expect(hb.failuresInARow).toBe(0)
		expect(dueCalls).toBeGreaterThan(hb.beats + 2)
	})

	test("logs a late beat, and stop aborts it and waits at most stopWaitMs", async () => {
		const lines: string[] = []
		let aborted = false
		const hb = startHeartbeat({
			intervalMs: TICK,
			slowMs: TICK,
			stopWaitMs: 50,
			log: (l) => lines.push(l),
			beat: (signal) =>
				new Promise<void>(() => {
					signal.addEventListener("abort", () => {
						aborted = true
					})
				}),
		})
		await Bun.sleep(TICK * 3)
		const t = performance.now()
		await hb.stop()
		await hb.stop()
		expect(performance.now() - t).toBeLessThan(200)
		expect(aborted).toBe(true)
		expect(lines.some((l) => l.includes("heartbeat beat open for"))).toBe(true)
	})
})
