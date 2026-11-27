import { describe, expect, it } from "vitest"
import { approvalFinalityLog } from "./approval-finality"

const settle = () => new Promise((r) => setTimeout(r, 0))

function harness(latest: bigint) {
	const reports: [string, Record<string, unknown>][] = []
	const inner: string[] = []
	let now = 1_000
	const log = approvalFinalityLog(
		{ latestRoot: async () => latest, report: (event, fields) => reports.push([event, fields]), now: () => now },
		(event) => inner.push(event),
	)
	return { log, reports, inner, tick: (ms: number) => (now += ms) }
}

describe("approval finality in the bot's log", () => {
	it("reports leaves the registry holds at latest once as a wait, and the post that carries them with the wait's length", async () => {
		const h = harness(7n)
		h.log("asp_root_mismatch", { chainRoot: 5n, aspRoot: 7n })
		await settle()
		h.tick(4_000)
		h.log("asp_root_mismatch", { chainRoot: 6n, aspRoot: 7n })
		await settle()
		h.tick(9_000)
		h.log("posted", { sequence: 3n, poolRoot: 7n })
		expect(h.reports).toEqual([
			["approval-finality-wait", { chainRoot: "5", aspRoot: 7n }],
			["approval-finality-reached", { poolRoot: 7n, sequence: "3", waitedMs: 4_000 }],
		])
		expect(h.inner).toEqual(["asp_root_mismatch", "asp_root_mismatch", "posted"])
	})

	it("adds nothing for leaves that build no root the registry holds at latest", async () => {
		const h = harness(9n)
		h.log("asp_root_mismatch", { chainRoot: 5n, aspRoot: 7n })
		await settle()
		h.log("posted", { sequence: 3n, poolRoot: 7n })
		expect([h.reports, h.inner]).toEqual([[], ["asp_root_mismatch", "posted"]])
	})
})
