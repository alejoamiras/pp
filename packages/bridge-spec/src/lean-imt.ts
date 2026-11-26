import { LeanIMT } from "@zk-kit/lean-imt"
import { assertField, assertRange, BN254_P, SpecRangeError } from "./fields"
import { circomPoseidon2 } from "./hash"

export const MAX_DEPTH = 18

/**
 * A membership path in `@zk-kit/lean-imt`'s proof format, field names as Noir's `pp_hash::LabelPath`:
 * `depth` counts siblings (a lone left child is promoted unhashed, so it is not the tree height),
 * bit `i` of `index` is 1 when the node is the right child at level `i`, and siblings past `depth` are 0.
 */
export type LabelPath = { index: number; depth: number; siblings: readonly bigint[] }

export type LeanImt = { root: bigint; size: number; path(leafIndex: number): LabelPath }

/**
 * Up to 2^18 leaves (past that an old leaf can need depth 19, which the circuit refuses), each in
 * [1, p): zk-kit's `insertMany` treats a zero right child as absent, so a zero leaf could yield a
 * root no path reproduces. Empty → root 0. The leaves are copied, so later edits to the array change nothing.
 */
export function buildLeanImt(leaves: readonly bigint[]): LeanImt {
	if (leaves.length > 2 ** MAX_DEPTH) throw new SpecRangeError("TreeTooLarge", "leaves", String(leaves.length))
	const all = [...leaves]
	for (const [i, leaf] of all.entries()) assertRange(leaf, 1n, BN254_P - 1n, "FieldOutOfRange", `leaves[${i}]`)
	const size = all.length
	const tree = new LeanIMT<bigint>(circomPoseidon2)
	if (size > 0) tree.insertMany(all)
	return {
		root: size === 0 ? 0n : tree.root,
		size,
		path(leafIndex: number): LabelPath {
			if (size === 0) throw new SpecRangeError("EmptyTree", "leaves")
			if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= size) {
				throw new SpecRangeError("IndexOutOfRange", "leafIndex", String(leafIndex))
			}
			const proof = tree.generateProof(leafIndex)
			return {
				index: proof.index,
				depth: proof.siblings.length,
				siblings: [...proof.siblings, ...Array<bigint>(MAX_DEPTH - proof.siblings.length).fill(0n)],
			}
		},
	}
}

function checkPath(path: LabelPath): void {
	if (!Number.isInteger(path.depth) || path.depth < 0 || path.depth > MAX_DEPTH) {
		throw new SpecRangeError("DepthOutOfRange", "depth", String(path.depth))
	}
	if (!Number.isInteger(path.index) || path.index < 0 || path.index >= 2 ** path.depth) {
		throw new SpecRangeError("IndexOutOfRange", "index", String(path.index))
	}
	if (path.siblings.length !== MAX_DEPTH) throw new SpecRangeError("SiblingOutOfRange", "siblings.length", String(path.siblings.length))
	// By index, not forEach: forEach skips the holes of a sparse array.
	for (let i = 0; i < MAX_DEPTH; i++) {
		const s = assertField(path.siblings[i] as bigint, `siblings[${i}]`)
		if (i >= path.depth && s !== 0n) throw new SpecRangeError("SiblingOutOfRange", `siblings[${i}]`, String(s))
	}
}

/** The root a path implies for `leaf`; the same rejections, in the same order, as Noir's `lean_imt_root`. */
export function leanImtRoot(leaf: bigint, path: LabelPath): bigint {
	checkPath(path)
	let node = assertField(leaf, "leaf")
	for (let i = 0; i < path.depth; i++) {
		const sibling = path.siblings[i] as bigint
		node = (path.index >> i) & 1 ? circomPoseidon2(sibling, node) : circomPoseidon2(node, sibling)
	}
	return node
}

/** `leaf` is in the tree with `root`; an empty tree's root (0) admits nothing. */
export function assertLeanImtMember(leaf: bigint, path: LabelPath, root: bigint): void {
	const computed = leanImtRoot(leaf, path)
	if (assertField(root, "root") === 0n) throw new SpecRangeError("ZeroRoot", "root")
	if (computed !== root) throw new SpecRangeError("NotMember", "root", String(root))
}
