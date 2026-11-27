import { aspLeaf, assertLeanImtMember, BN254_P, buildLeanImt } from "@pp/bridge-spec"
import { describe, expect, it } from "vitest"
import fixture from "../test/fixtures/mock-asp.json"
import { parseAspSnapshot, parseAspSnapshotUnverified, serializeAspSnapshot } from "./codec"
import { type AspSnapshot, labelState, MAX_LEAVES, pathFor, type RootRecord, SnapshotError, verifySnapshot } from "./snapshot"

const poolLeaves = fixture.leaves.map(BigInt)
const birthLabels = [11n, 22n, 33n, 44n, 55n]
const birthLeaves = birthLabels.map(aspLeaf).sort((a, b) => (a < b ? -1 : 1))
const snap: AspSnapshot = {
	sequence: 7n,
	poolRoot: BigInt(fixture.root),
	birthRoot: buildLeanImt(birthLeaves).root,
	poolLeaves,
	birthLeaves,
}
const label = (i: number) => BigInt(fixture.labels[i] as string)

describe("snapshots", () => {
	it("reproduce the mock ASP's own leaves and root", () => {
		const live = fixture.labels.filter((l) => !fixture.revoked.includes(l) || l === fixture.reapproved)
		const order = [...live.filter((l) => l !== fixture.reapproved), fixture.reapproved]
		expect(order.map((l) => aspLeaf(BigInt(l)))).toEqual(poolLeaves)
		expect(() => verifySnapshot(snap)).not.toThrow()
	})

	it("give a path the circuit's membership check accepts, in the origin's tree only", () => {
		for (const [origin, l, root] of [
			[0, label(0), snap.poolRoot],
			[1, birthLabels[2] as bigint, snap.birthRoot],
		] as const) {
			const path = pathFor(snap, l, origin)
			expect(path).not.toBeNull()
			expect(() => assertLeanImtMember(aspLeaf(l), path!, root)).not.toThrow()
		}
		expect(pathFor(snap, label(0), 1)).toBeNull()
		expect(pathFor(snap, birthLabels[0] as bigint, 0)).toBeNull()
		expect(pathFor(snap, 999n, 0)).toBeNull()
	})

	it("find a label by value after a revocation shifted its index", () => {
		const after = label(5)
		expect(poolLeaves.indexOf(aspLeaf(after))).toBe(4)
		const path = pathFor(snap, after, 0)!
		expect(path.index).toBe(4)
		expect(() => assertLeanImtMember(aspLeaf(after), path, snap.poolRoot)).not.toThrow()
		expect(pathFor(snap, label(4), 0)).toBeNull()
	})

	it("answer labelState like check_label, at both time bounds", () => {
		const T = 10_000n
		const r: RootRecord = { sequence: 7n, poolRoot: snap.poolRoot, birthRoot: snap.birthRoot, l1Block: 5n, rootTime: T }
		expect(labelState(r, snap, label(0), 0, T + 1800n)).toBe("ACTIVE")
		expect(labelState(r, snap, label(0), 0, T + 1801n)).toBe("STALE_ROOT")
		expect(labelState(r, snap, label(0), 0, T - 1n)).toBe("STALE_ROOT")
		expect(labelState({ ...r, poolRoot: 1n }, snap, label(0), 0, T)).toBe("STALE_ROOT")
		expect(labelState(r, snap, label(4), 0, T)).toBe("ABSENT")
		const noBirths = { ...snap, birthLeaves: [], birthRoot: 0n }
		expect(labelState({ ...r, birthRoot: 0n }, noBirths, birthLabels[0] as bigint, 1, T)).toBe("ABSENT")
	})

	it("round-trip on the wire and refuse every malformed shape", () => {
		const wire = JSON.parse(serializeAspSnapshot(snap))
		expect(parseAspSnapshot(wire)).toEqual(snap)
		const cases: [string, (w: Record<string, unknown>) => unknown, string][] = [
			["wrong pool root", (w) => ({ ...w, poolRoot: "1" }), "RootMismatch"],
			["wrong birth root", (w) => ({ ...w, birthRoot: "1" }), "RootMismatch"],
			["unsorted birth leaves", (w) => ({ ...w, birthLeaves: [...(w.birthLeaves as string[])].reverse() }), "UnsortedBirthLeaves"],
			["duplicated birth leaf", (w) => ({ ...w, birthLeaves: Array(2).fill((w.birthLeaves as string[])[0]) }), "UnsortedBirthLeaves"],
			["leaves under root 0", (w) => ({ ...w, poolRoot: "0" }), "RootMismatch"],
			["zero leaf", (w) => ({ ...w, poolLeaves: ["0"] }), "OutOfRange"],
			["leaf ≥ p", (w) => ({ ...w, poolLeaves: [BN254_P.toString()] }), "OutOfRange"],
			["too many leaves", (w) => ({ ...w, poolLeaves: Array(MAX_LEAVES + 1).fill("1") }), "TooManyLeaves"],
			["sequence 0", (w) => ({ ...w, sequence: "0" }), "OutOfRange"],
			["unknown key", (w) => ({ ...w, cid: "x" }), "Malformed"],
			["missing key", ({ birthLeaves: _, ...w }) => w, "Malformed"],
			["hex number", (w) => ({ ...w, sequence: "0x7" }), "Malformed"],
			["leading zero", (w) => ({ ...w, sequence: "07" }), "Malformed"],
			["JSON number", (w) => ({ ...w, sequence: 7 }), "Malformed"],
			["not an object", () => [], "Malformed"],
		]
		const errorOf = (f: () => unknown) => {
			try {
				f()
			} catch (e) {
				return e
			}
		}
		expect(parseAspSnapshotUnverified(wire)).toEqual(snap)
		for (const [name, mutate, code] of cases) {
			const err = errorOf(() => parseAspSnapshot(mutate(wire)))
			expect(err, name).toBeInstanceOf(SnapshotError)
			expect((err as SnapshotError).code, name).toBe(code)
			// The unverified parse builds no tree, so it takes a root as declared and refuses everything else the same way.
			const shallow = errorOf(() => parseAspSnapshotUnverified(mutate(wire)))
			expect((shallow as SnapshotError | undefined)?.code, name).toBe(code === "RootMismatch" ? undefined : code)
		}
	})
})
