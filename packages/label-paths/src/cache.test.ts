import { aspLeaf, buildLeanImt, circomPoseidon2 } from "@pp/bridge-spec"
import { beforeEach, describe, expect, it, vi } from "vitest"
import fixture from "../test/fixtures/mock-asp.json"
import { LabelPathCache } from "./cache"
import { type AspSnapshot, labelState, pathFor, type RootRecord, SnapshotError } from "./snapshot"

const calls = vi.hoisted(() => ({ builds: 0, leafHashes: 0 }))
vi.mock("@pp/bridge-spec", async (importOriginal) => {
	const spec = await importOriginal<typeof import("@pp/bridge-spec")>()
	return {
		...spec,
		buildLeanImt: (...a: Parameters<typeof spec.buildLeanImt>) => {
			calls.builds++
			return spec.buildLeanImt(...a)
		},
		aspLeaf: (label: bigint) => {
			calls.leafHashes++
			return spec.aspLeaf(label)
		},
	}
})

const poolLeaves = fixture.leaves.map(BigInt)
const birthLabels = [11n, 22n, 33n]
const birthLeaves = birthLabels.map(aspLeaf).sort((a, b) => (a < b ? -1 : 1))
const snap: AspSnapshot = {
	sequence: 7n,
	poolRoot: BigInt(fixture.root),
	birthRoot: buildLeanImt(birthLeaves).root,
	poolLeaves,
	birthLeaves,
}
const label = (i: number) => BigInt(fixture.labels[i] as string)
const T = 10_000n
const record = (over: Partial<RootRecord> = {}): RootRecord => ({
	sequence: 7n,
	poolRoot: snap.poolRoot,
	birthRoot: snap.birthRoot,
	l1Block: 5n,
	rootTime: T,
	...over,
})
const reset = () => {
	calls.builds = 0
	calls.leafHashes = 0
}

beforeEach(reset)

describe("LabelPathCache", () => {
	it("builds a found label's tree once per root, also across a heartbeat and the other origin", () => {
		const [p0, p5] = [pathFor(snap, label(0), 0), pathFor(snap, label(5), 0)]
		const cache = new LabelPathCache()
		reset()
		expect(cache.check(record(), snap, label(0), 0, T)).toEqual({ state: "ACTIVE", path: p0 })
		const beat = { ...snap, sequence: 8n }
		expect(cache.check(record({ sequence: 8n, rootTime: T + 300n }), beat, label(5), 0, T + 300n)).toEqual({
			state: "ACTIVE",
			path: p5,
		})
		expect(cache.check(record(), snap, birthLabels[1] as bigint, 1, T).state).toBe("ACTIVE")
		expect(cache.check(record(), snap, label(1), 0, T).state).toBe("ACTIVE")
		expect(calls.builds).toBe(2)
	})

	it("answers ABSENT only after its origin's list builds to the root, building each list once", () => {
		const cache = new LabelPathCache()
		const noBirths = { ...snap, birthLeaves: [], birthRoot: 0n }
		expect(cache.check(record(), snap, 999n, 0, T)).toEqual({ state: "ABSENT" })
		expect(cache.check(record(), snap, label(0), 1, T)).toEqual({ state: "ABSENT" })
		expect(cache.check(record(), { ...snap, sequence: 8n }, 998n, 0, T)).toEqual({ state: "ABSENT" })
		expect(cache.check(record({ birthRoot: 0n }), noBirths, birthLabels[0] as bigint, 1, T)).toEqual({ state: "ABSENT" })
		expect(calls).toEqual({ builds: 2, leafHashes: 3 })
	})

	it("does not answer ABSENT from a list that does not build to the declared root, and keeps the verified tree", () => {
		const omitted = { ...snap, poolLeaves: poolLeaves.filter((_, i) => i !== 3) }
		const cache = new LabelPathCache()
		expect(cache.check(record(), snap, 999n, 0, T)).toEqual({ state: "ABSENT" })
		expect(() => cache.check(record(), omitted, label(3), 0, T)).toThrow("RootMismatch: poolRoot")
		expect(() => cache.check(record(), omitted, 999n, 0, T)).toThrow("RootMismatch: poolRoot")
		expect(cache.check(record(), snap, label(3), 0, T)).toEqual({ state: "ACTIVE", path: pathFor(snap, label(3), 0) })
		expect(calls.builds).toBe(4)
	})

	it("compares the declared roots with the record before any hash, and says why a root is stale", () => {
		const cache = new LabelPathCache()
		expect(cache.check(record({ poolRoot: 1n }), snap, label(0), 0, T)).toEqual({ state: "STALE_ROOT", reason: "snapshot" })
		expect(cache.check(record({ birthRoot: 1n }), snap, birthLabels[0] as bigint, 1, T)).toEqual({
			state: "STALE_ROOT",
			reason: "snapshot",
		})
		expect(cache.check(record(), snap, label(0), 0, T + 1801n)).toEqual({ state: "STALE_ROOT", reason: "age" })
		expect(cache.check(record(), snap, label(0), 0, T - 1n)).toEqual({ state: "STALE_ROOT", reason: "age" })
		expect(calls).toEqual({ builds: 0, leafHashes: 0 })
		expect(labelState(record(), snap, label(0), 0, T + 1800n)).toBe("ACTIVE")
		expect(cache.check(record(), snap, label(0), 0, T + 1800n).state).toBe("ACTIVE")
	})

	it("refuses a list that does not build to its root and keeps nothing; a collapsed list cannot hide labels later", () => {
		const forged = 4242n
		const liar = { ...snap, poolLeaves: [...poolLeaves.slice(0, -1), aspLeaf(forged)] }
		// Five leaves collapse to their level-one nodes, which keep the root and the promoted fifth leaf.
		const five = [1n, 2n, 3n, 4n, 5n].map(aspLeaf)
		const [a, b, c, d, e] = five as [bigint, bigint, bigint, bigint, bigint]
		const full = { ...snap, poolLeaves: five, poolRoot: buildLeanImt(five).root }
		const collapsed = { ...full, poolLeaves: [circomPoseidon2(a, b), circomPoseidon2(c, d), e] }
		const fullPath = pathFor(full, 1n, 0)
		const cache = new LabelPathCache()
		reset()
		expect(() => cache.check(record(), liar, forged, 0, T)).toThrow(SnapshotError)
		expect(() => cache.check(record(), liar, forged, 0, T)).toThrow("RootMismatch: poolRoot")
		const r = record({ poolRoot: full.poolRoot })
		expect(cache.check(r, collapsed, 5n, 0, T).state).toBe("ACTIVE")
		expect(cache.check(r, collapsed, 1n, 0, T)).toEqual({ state: "ABSENT" })
		expect(cache.check(r, full, 1n, 0, T)).toEqual({ state: "ACTIVE", path: fullPath })
		expect(cache.check(r, full, 2n, 0, T).state).toBe("ACTIVE")
		expect(calls.builds).toBe(4)
	})

	it("drops a tree once the record moves to a new root, and builds the new one once", () => {
		const cache = new LabelPathCache()
		expect(cache.check(record(), snap, label(0), 0, T).state).toBe("ACTIVE")
		const moved = { ...snap, sequence: 8n, poolLeaves: poolLeaves.slice(1), poolRoot: buildLeanImt(poolLeaves.slice(1)).root }
		const next = record({ sequence: 8n, poolRoot: moved.poolRoot })
		const p5 = pathFor(moved, label(5), 0)
		reset()
		expect(cache.check(next, moved, label(5), 0, T)).toEqual({ state: "ACTIVE", path: p5 })
		expect(cache.check(next, moved, label(6), 0, T).state).toBe("ACTIVE")
		expect(calls.builds).toBe(1)
		expect(cache.check(record(), snap, label(0), 0, T).state).toBe("ACTIVE")
		expect(calls.builds).toBe(2)
		for (const maxTrees of [0, 1.5, null]) expect(() => new LabelPathCache({ maxTrees } as never)).toThrow(RangeError)
	})
})
