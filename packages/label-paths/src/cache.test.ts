import { aspLeaf, BN254_P, buildLeanImt } from "@pp/bridge-spec"
import { describe, expect, it } from "vitest"
import fixture from "../test/fixtures/mock-asp.json"
import { LabelPathCache } from "./cache"
import { type AspSnapshot, labelState, pathFor, type RootRecord, SnapshotError } from "./snapshot"

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

/** A cache whose builds and hashes are counted through its progress hook. */
function counted() {
	const n = { builds: 0, hashes: 0 }
	const cache = new LabelPathCache({
		onProgress: (hashed) => {
			n.hashes++
			if (hashed === 1) n.builds++
		},
	})
	return { cache, n }
}

describe("LabelPathCache", () => {
	it("builds a found label's tree once per root, and a heartbeat's record with that root reuses it", () => {
		const { cache, n } = counted()
		expect(cache.check(record(), snap, label(0), 0, T)).toEqual({ state: "ACTIVE", path: pathFor(snap, label(0), 0) })
		expect(n).toEqual({ builds: 1, hashes: poolLeaves.length - 1 })
		const beat = { ...snap, sequence: 8n }
		expect(cache.check(record({ sequence: 8n, rootTime: T + 300n }), beat, label(5), 0, T + 300n)).toEqual({
			state: "ACTIVE",
			path: pathFor(snap, label(5), 0),
		})
		expect(n.builds).toBe(1)
		expect(cache.check(record(), snap, birthLabels[1] as bigint, 1, T)).toEqual({
			state: "ACTIVE",
			path: pathFor(snap, birthLabels[1] as bigint, 1),
		})
		expect(n.builds).toBe(2)
	})

	it("answers ABSENT without building a tree when the label is not in its origin's list", () => {
		const { cache, n } = counted()
		expect(cache.check(record(), snap, 999n, 0, T)).toEqual({ state: "ABSENT" })
		expect(cache.check(record(), snap, label(0), 1, T)).toEqual({ state: "ABSENT" })
		const noBirths = { ...snap, birthLeaves: [], birthRoot: 0n }
		expect(cache.check(record({ birthRoot: 0n }), noBirths, birthLabels[0] as bigint, 1, T)).toEqual({ state: "ABSENT" })
		expect(n.hashes).toBe(0)
	})

	it("compares the declared roots with the record before any hash, and says why a root is stale", () => {
		const { cache, n } = counted()
		// A label ≥ p makes its leaf hash throw, so reaching a stale answer proves nothing was hashed first.
		expect(cache.check(record({ poolRoot: 1n }), snap, BN254_P, 0, T)).toEqual({ state: "STALE_ROOT", reason: "snapshot" })
		expect(cache.check(record({ birthRoot: 1n }), snap, BN254_P, 1, T)).toEqual({ state: "STALE_ROOT", reason: "snapshot" })
		expect(cache.check(record(), snap, BN254_P, 0, T + 1801n)).toEqual({ state: "STALE_ROOT", reason: "age" })
		expect(cache.check(record(), snap, BN254_P, 0, T - 1n)).toEqual({ state: "STALE_ROOT", reason: "age" })
		expect(() => cache.check(record(), snap, BN254_P, 0, T)).toThrow("FieldOutOfRange")
		expect(n.hashes).toBe(0)
		// The boundaries match labelState's.
		expect(labelState(record(), snap, label(0), 0, T + 1800n)).toBe("ACTIVE")
		expect(cache.check(record(), snap, label(0), 0, T + 1800n).state).toBe("ACTIVE")
	})

	it("refuses leaves that do not build to the declared root, keeps nothing, and then builds the honest ones once", () => {
		const { cache, n } = counted()
		const forged = 4242n
		const liar = { ...snap, poolLeaves: [...poolLeaves.slice(0, -1), aspLeaf(forged)] }
		expect(() => cache.check(record(), liar, forged, 0, T)).toThrow(SnapshotError)
		expect(() => cache.check(record(), liar, forged, 0, T)).toThrow("RootMismatch: poolRoot")
		expect(n.builds).toBe(2)
		expect(cache.check(record(), snap, label(0), 0, T).state).toBe("ACTIVE")
		expect(cache.check(record(), snap, label(1), 0, T).state).toBe("ACTIVE")
		expect(n.builds).toBe(3)
		// Once the root is verified, a snapshot claiming it is read through the verified leaves.
		expect(cache.check(record(), liar, forged, 0, T)).toEqual({ state: "ABSENT" })
	})

	it("drops a tree once the record moves to a new root, and builds the new one once", () => {
		const { cache, n } = counted()
		expect(cache.check(record(), snap, label(0), 0, T).state).toBe("ACTIVE")
		const moved = { ...snap, sequence: 8n, poolLeaves: poolLeaves.slice(1), poolRoot: buildLeanImt(poolLeaves.slice(1)).root }
		const next = record({ sequence: 8n, poolRoot: moved.poolRoot })
		expect(cache.check(next, moved, label(5), 0, T)).toEqual({ state: "ACTIVE", path: pathFor(moved, label(5), 0) })
		expect(cache.check(next, moved, label(6), 0, T).state).toBe("ACTIVE")
		expect(n.builds).toBe(2)
		// Back on the old record, its tree was dropped and builds again.
		expect(cache.check(record(), snap, label(0), 0, T).state).toBe("ACTIVE")
		expect(n.builds).toBe(3)
		expect(() => new LabelPathCache({ maxTrees: 0 })).toThrow(RangeError)
	})
})
