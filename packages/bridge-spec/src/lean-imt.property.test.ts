import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { BN254_P, SpecRangeError } from "./fields"
import { assertLeanImtMember, buildLeanImt, type LabelPath, leanImtRoot, MAX_DEPTH } from "./lean-imt"

const field = fc.bigInt({ min: 1n, max: BN254_P - 1n })
// Small values repeat often, so trees with duplicate leaves are common.
const leaf = fc.oneof(field, fc.bigInt({ min: 1n, max: 4n }))
const EDGES = [1, 2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 64, 65, 128, 129, 256]
const size = (max: number) => fc.oneof(fc.integer({ min: 1, max }), fc.constantFrom(...EDGES.filter((n) => n <= max)))
const leavesOf = (max: number) => size(max).chain((n) => fc.array(leaf, { minLength: n, maxLength: n }))

/** Every index up to 32 leaves; past that 16, always including the first and the last. */
const sample = (n: number): number[] =>
	n <= 32 ? [...Array(n).keys()] : [0, n - 1, ...Array.from({ length: 14 }, (_, k) => Math.floor(((k + 1) * n) / 15))]

/** zk-kit's proof shape for leaf `i` of `n`: one bit per level where the node has a sibling, lowest level first. */
const expectedShape = (n: number, i: number) => {
	let depth = 0
	let index = 0
	for (let width = n, j = i; width > 1; width = Math.ceil(width / 2), j >>= 1) {
		if ((j ^ 1) < width) {
			index |= (j & 1) << depth
			depth++
		}
	}
	return { index, depth }
}

const failsMembership = (leaf: bigint, path: LabelPath, root: bigint) => {
	try {
		assertLeanImtMember(leaf, path, root)
	} catch (e) {
		if (e instanceof SpecRangeError) return true
		throw e
	}
	return false
}

describe("LeanIMT properties (the TS tree against its own paths; Noir agreement is the shared vectors)", () => {
	const members = propertyParams(import.meta.url, "every leaf verifies at its depth", 20, 4_000)
	it(
		"every leaf verifies at its depth",
		() => {
			fc.assert(
				fc.property(leavesOf(256), (leaves) => {
					const tree = buildLeanImt(leaves)
					for (const i of sample(leaves.length)) {
						const path = tree.path(i)
						// Exact, so a repeated leaf cannot borrow another position's proof.
						expect({ index: path.index, depth: path.depth }).toEqual(expectedShape(leaves.length, i))
						assertLeanImtMember(leaves[i] as bigint, path, tree.root)
					}
				}),
				members.fc,
			)
		},
		members.testTimeout,
	)

	const outsiders = propertyParams(import.meta.url, "a value not in the tree fails with any of its paths", 40, 3_000)
	it(
		"a value not in the tree fails with any of its paths",
		() => {
			const input = leavesOf(64).chain((leaves) =>
				fc.record({
					leaves: fc.constant(leaves),
					index: fc.nat({ max: leaves.length - 1 }),
					outsider: field.filter((v) => !leaves.includes(v)),
				}),
			)
			fc.assert(
				fc.property(input, ({ leaves, index, outsider }) => {
					const tree = buildLeanImt(leaves)
					expect(failsMembership(outsider, tree.path(index), tree.root)).toBe(true)
				}),
				outsiders.fc,
			)
		},
		outsiders.testTimeout,
	)

	const tampered = propertyParams(import.meta.url, "a changed sibling or depth fails", 60, 3_000)
	it(
		"a changed sibling or depth fails",
		() => {
			const input = leavesOf(64)
				.filter((leaves) => leaves.length >= 2)
				.chain((leaves) =>
					fc.record({
						leaves: fc.constant(leaves),
						index: fc.nat({ max: leaves.length - 1 }),
						change: fc.oneof(
							fc.record({ kind: fc.constant("sibling" as const), at: fc.nat(), to: field }),
							fc.record({ kind: fc.constantFrom("deeper" as const, "shallower" as const) }),
						),
					}),
				)
			fc.assert(
				fc.property(input, ({ leaves, index, change }) => {
					const tree = buildLeanImt(leaves)
					const path = tree.path(index)
					const siblings = [...path.siblings]
					let depth = path.depth
					let at = path.index
					if (change.kind === "sibling") {
						fc.pre(path.depth > 0)
						const k = change.at % path.depth
						fc.pre(siblings[k] !== change.to)
						siblings[k] = change.to
					} else if (change.kind === "deeper") {
						fc.pre(depth < MAX_DEPTH)
						depth += 1
					} else {
						// Well-formed at the shorter depth, so it reaches the root comparison, not checkPath.
						fc.pre(depth > 0)
						depth -= 1
						siblings[depth] = 0n
						at &= (1 << depth) - 1
					}
					expect(failsMembership(leaves[index] as bigint, { index: at, depth, siblings }, tree.root)).toBe(true)
				}),
				tampered.fc,
			)
		},
		tampered.testTimeout,
	)

	// About 20 s to build on a fast host, so only the nightly sets FC_DEEP.
	it.runIf(process.env.FC_DEEP === "1")(
		"a tree of 2^17 + 1 leaves gives its first leaf a depth-18 path and its last a depth-1 path",
		() => {
			const n = 2 ** 17 + 1
			const leaves = Array.from({ length: n }, (_, i) => BigInt(i + 1))
			const tree = buildLeanImt(leaves)
			expect(tree.path(0).depth).toBe(MAX_DEPTH)
			expect(tree.path(n - 1).depth).toBe(1)
			for (const i of sample(n)) expect(leanImtRoot(leaves[i] as bigint, tree.path(i))).toBe(tree.root)
		},
		180_000,
	)
})
