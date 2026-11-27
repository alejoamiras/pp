import { MAX_ROOT_AGE, SPEND_WINDOW } from "@pp/label-paths"
import type { Hex } from "viem"
import { describe, expect, it, vi } from "vitest"

const { labelState } = vi.hoisted(() => ({ labelState: vi.fn(() => "ACTIVE") }))
vi.mock("@pp/label-paths", async (actual) => ({ ...(await actual<typeof import("@pp/label-paths")>()), labelState }))

const { assessSpend, freshnessMargin, readL1Root } = await import("./checked-transfer")
type SpendFacts = Parameters<typeof assessSpend>[0]

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const ANCHOR_TIME = 1_700_000_000n
/** A record whose time leaves the anchor exactly `margin` seconds. */
const rootTimeFor = (margin: bigint) => ANCHOR_TIME + SPEND_WINDOW - MAX_ROOT_AGE + margin

const passing = (): SpendFacts => ({
	label: 7n,
	origin: 0,
	minSequence: 5n,
	post: { block: 100, blockHash: h(100) },
	anchor: { number: 120, hash: h(120), timestamp: ANCHOR_TIME },
	canonical: { anchor: h(120), post: h(100) },
	record: { sequence: 5n, poolRoot: 11n, birthRoot: 12n, l1Block: 900n, rootTime: rootTimeFor(400n) },
	snapshot: { sequence: 5n, poolRoot: 11n, birthRoot: 12n, poolLeaves: [], birthLeaves: [] },
	l1: { l1Block: 900n, l1BlockHash: h(900), latestRoot: 11n, timestamp: rootTimeFor(400n) },
})

describe("a checked spend's checks at its anchor", () => {
	it("passes, reporting the margin and parity, when every check holds", () => {
		expect(assessSpend(passing())).toEqual({ failed: [], margin: 400n, parity: { poolRoot: true, rootTime: true } })
	})

	it("names exactly the check each disagreement breaks", () => {
		const cases: [string, (f: SpendFacts) => SpendFacts][] = [
			["anchor-height", (f) => ({ ...f, anchor: { ...f.anchor, number: 99 } })],
			["anchor-canonical", (f) => ({ ...f, canonical: { ...f.canonical, anchor: h(121) } })],
			["post-canonical", (f) => ({ ...f, canonical: { ...f.canonical, post: undefined } })],
			["sequence", (f) => ({ ...f, record: { ...f.record, sequence: 4n } })],
			[
				"label",
				(f) => {
					labelState.mockReturnValueOnce("STALE_ROOT")
					return f
				},
			],
			["pool-root", (f) => ({ ...f, l1: { ...f.l1, latestRoot: 10n } })],
			["pool-root", (f) => ({ ...f, l1: { ...f.l1, l1Block: 901n } })],
			["root-time", (f) => ({ ...f, l1: { ...f.l1, timestamp: f.l1.timestamp + 1n } })],
		]
		for (const [check, perturb] of cases) expect([check, assessSpend(perturb(passing())).failed]).toEqual([check, [check]])
	})

	it("requires a positive margin, where the circuit accepts zero", () => {
		expect(freshnessMargin(rootTimeFor(0n), ANCHOR_TIME)).toBe(0n)
		const at = (margin: bigint) => {
			const f = passing()
			const rootTime = rootTimeFor(margin)
			return assessSpend({ ...f, record: { ...f.record, rootTime }, l1: { ...f.l1, timestamp: rootTime } }).failed
		}
		expect([at(1n), at(0n), at(-1n)]).toEqual([[], ["margin"], ["margin"]])
	})
})

describe("the record's parity read", () => {
	it("reads the registry's root at the hash of the header at the record's L1 block", async () => {
		const calls: unknown[][] = []
		const l1 = {
			request: async ({ method, params }: { method: string; params: unknown[] }) => {
				calls.push([method, params])
				if (method === "eth_getBlockByNumber") return { hash: h(0xabc), timestamp: "0x10" }
				return h(42)
			},
		}
		const root = await readL1Root(l1 as never, "0x0000000000000000000000000000000000000013", 900n)
		expect(root).toEqual({ l1Block: 900n, l1BlockHash: h(0xabc), latestRoot: 42n, timestamp: 16n })
		expect(calls.map(([m, p]) => [m, (p as unknown[])[0] === "0x384" || (p as unknown[])[1]])).toEqual([
			["eth_getBlockByNumber", true],
			["eth_call", { blockHash: h(0xabc) }],
		])
	})
})
