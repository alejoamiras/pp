import { describe, expect, it } from "vitest"
import { BN254_P, SpecRangeError } from "./fields"
import { aspLeaf, changeCommitment, circomPoseidon1, circomPoseidon2 } from "./hash"
import { assertLeanImtMember, buildLeanImt, type LabelPath, leanImtRoot, MAX_DEPTH } from "./lean-imt"

const code = (f: () => unknown) => {
	try {
		f()
	} catch (e) {
		if (e instanceof SpecRangeError) return e.code
		throw e
	}
	return "no error"
}

describe("circom Poseidon (poseidon-lite) against the spike's circomlibjs-checked values", () => {
	it("pins hash_1, hash_2 and the pool formulas", () => {
		expect(circomPoseidon1(0n)).toBe(0x2a09a9fd93c590c26b91effbb2499f07e8f7aa12e2b4940a3aed2411cb65e11cn)
		expect(circomPoseidon2(1n, 2n)).toBe(0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189an)
		const precommitment = 0x17fd1e476b18bf643797adf1565619e48cdfc1f889423ec70c98da2ae6dfe0f1n
		const label = 0xcc3e484169169c1777a5b2c10b785a3e48c4b249484b28b1fd4171fe5ac23c6n
		expect(changeCommitment(precommitment, label)).toBe(0x1312adb73722129f4ba6da478764fc540f34bef8557a25a71453c7dd477fa27an)
		expect(aspLeaf(label)).toBe(0x16522ee878c26b1b2779043dfc3d7a97101bbb6badd20cd027e6838854b452f9n)
	})

	it("refuses an input ≥ p instead of reducing it", () => {
		expect(code(() => circomPoseidon1(BN254_P))).toBe("FieldOutOfRange")
	})
})

describe("LeanIMT", () => {
	const leaves = (n: number) => Array.from({ length: n }, (_, i) => aspLeaf(BigInt(i + 1)))

	it("every leaf of trees of 1 to 9 leaves verifies against its root, promoted leaves included", () => {
		for (let n = 1; n <= 9; n++) {
			const tree = buildLeanImt(leaves(n))
			for (let i = 0; i < n; i++) {
				const path = tree.path(i)
				expect(path.siblings).toHaveLength(MAX_DEPTH)
				expect(leanImtRoot(leaves(n)[i] as bigint, path)).toBe(tree.root)
				assertLeanImtMember(leaves(n)[i] as bigint, path, tree.root)
			}
		}
	})

	it("reports progress up to the exact hash count of the build without changing its root or paths", () => {
		for (const n of [0, 1, 2, 3, 5, 8, 13, 100]) {
			const calls: [number, number][] = []
			const tree = buildLeanImt(leaves(n), { onProgress: (hashed, total) => calls.push([hashed, total]) })
			const plain = buildLeanImt(leaves(n))
			expect(tree.root, `n=${n}`).toBe(plain.root)
			for (let i = 0; i < n; i++) expect(tree.path(i)).toEqual(plain.path(i))
			const total = Math.max(0, n - 1)
			expect(calls, `n=${n}`).toEqual(Array.from({ length: total }, (_, i) => [i + 1, total]))
		}
	})

	it("an empty tree has root 0 and no paths; more than 2^18 leaves are refused", () => {
		const empty = buildLeanImt([])
		expect(empty.root).toBe(0n)
		expect(code(() => empty.path(0))).toBe("EmptyTree")
		expect(code(() => buildLeanImt(Array<bigint>(2 ** MAX_DEPTH + 1).fill(1n)))).toBe("TreeTooLarge")
	})

	it("refuses a zero leaf, which zk-kit would treat as an absent right child", () => {
		expect(code(() => buildLeanImt([1n, 0n]))).toBe("FieldOutOfRange")
	})

	it("a built tree ignores later edits to the leaves array", () => {
		const input = [aspLeaf(1n)]
		const tree = buildLeanImt(input)
		input.pop()
		expect(leanImtRoot(aspLeaf(1n), tree.path(0))).toBe(tree.root)
	})

	const tree = buildLeanImt(leaves(5))
	const leaf = leaves(5)[1] as bigint
	const good = tree.path(1)
	const withPath = (p: Partial<LabelPath>) => ({ ...good, ...p })
	const siblings = (f: (s: bigint[]) => void) => {
		const s = [...good.siblings]
		f(s)
		return s
	}

	it.each([
		["depth 19", () => leanImtRoot(leaf, withPath({ depth: 19 })), "DepthOutOfRange"],
		["fractional depth", () => leanImtRoot(leaf, withPath({ depth: 1.5 })), "DepthOutOfRange"],
		["an index bit at depth", () => leanImtRoot(leaf, withPath({ index: good.index | (1 << good.depth) })), "IndexOutOfRange"],
		["fractional index", () => leanImtRoot(leaf, withPath({ index: 0.5 })), "IndexOutOfRange"],
		["17 siblings", () => leanImtRoot(leaf, withPath({ siblings: good.siblings.slice(1) })), "SiblingOutOfRange"],
		["a sparse siblings array", () => leanImtRoot(7n, { index: 0, depth: 0, siblings: Array<bigint>(MAX_DEPTH) }), "FieldOutOfRange"],
		[
			"a non-zero sibling past depth",
			() =>
				leanImtRoot(
					leaf,
					withPath({
						siblings: siblings((s) => {
							s[good.depth] = 1n
						}),
					}),
				),
			"SiblingOutOfRange",
		],
		[
			"a sibling ≥ p",
			() =>
				leanImtRoot(
					leaf,
					withPath({
						siblings: siblings((s) => {
							s[0] = BN254_P
						}),
					}),
				),
			"FieldOutOfRange",
		],
		["root 0", () => assertLeanImtMember(leaf, good, 0n), "ZeroRoot"],
		["a wrong root", () => assertLeanImtMember(leaf, good, tree.root + 1n), "NotMember"],
	])("%s", (_, f, want) => {
		expect(code(f)).toBe(want)
	})
})
