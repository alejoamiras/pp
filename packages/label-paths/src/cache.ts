import { aspLeaf, buildLeanImt, type LabelPath, type LeanImt } from "@pp/bridge-spec"
import { type AspSnapshot, assertSizes, type Origin, type RootRecord, rootFresh, SnapshotError, treeOf } from "./snapshot"

/**
 * `ABSENT`: the label is not in the origin's list, a list of the record's length that builds to its root.
 * `STALE_ROOT` says what to do next. `snapshot`: its roots are not the record's, so fetch the record's
 * own sequence. `age`: the record is too old for a spend, so wait for the next post; a record newer
 * than `nowSec` instead means it was not read at the anchor block.
 */
export type LabelCheck = { state: "ACTIVE"; path: LabelPath } | { state: "ABSENT" } | { state: "STALE_ROOT"; reason: "snapshot" | "age" }

export type LabelPathCacheOptions = {
	/** Runs after each hash of a tree build, with that build's exact total. It must not call `check`. */
	onProgress?: (hashed: number, total: number) => void
	/** Verified trees kept; default 2, one per origin. */
	maxTrees?: number
}

type Entry = { leaves: readonly bigint[]; tree: LeanImt }

const sameList = (a: readonly bigint[], b: readonly bigint[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * `labelState` plus `pathFor`, answering from the given snapshot alone, with each verified tree kept
 * by root. A root proves a path, not that a list is complete (a collapsed subtree keeps the root), so
 * a kept tree serves only a snapshot whose list is the one it was built from.
 */
export class LabelPathCache {
	private readonly trees = new Map<bigint, Entry>()
	private readonly maxTrees: number

	constructor(private readonly opts: LabelPathCacheOptions = {}) {
		const max = opts.maxTrees === undefined ? 2 : opts.maxTrees
		if (!(Number.isSafeInteger(max) && max >= 1)) throw new RangeError(`maxTrees must be a positive integer: ${max}`)
		this.maxTrees = max
	}

	/**
	 * Same rules as `labelState`; `r` is the record at the anchor block and `nowSec` its time plus the
	 * proving budget. `ACTIVE` and `ABSENT` come only from an origin list that builds to the declared root:
	 * it is built, or the tree kept for that root is reused while its list is the same. Throws
	 * `SnapshotError("RootMismatch")` when the list does not build to the root, whether or not the label is
	 * in it; that list is not kept, and a tree already verified for the root stays. Throws
	 * `SnapshotError("SizeMismatch")`, before any hash, when either list's length is not the record's.
	 */
	check(r: RootRecord, s: AspSnapshot, label: bigint, origin: Origin, nowSec: bigint): LabelCheck {
		for (const root of this.trees.keys()) if (root !== r.poolRoot && root !== r.birthRoot) this.trees.delete(root)
		if (s.poolRoot !== r.poolRoot || s.birthRoot !== r.birthRoot) return { state: "STALE_ROOT", reason: "snapshot" }
		if (!rootFresh(r, nowSec)) return { state: "STALE_ROOT", reason: "age" }
		assertSizes(r, s)
		const { leaves, root, field } = treeOf(s, origin)
		if (root === 0n) {
			if (leaves.length > 0) throw new SnapshotError("RootMismatch", field)
			return { state: "ABSENT" }
		}
		const cached = this.trees.get(root)
		const entry = cached && sameList(cached.leaves, leaves) ? cached : this.build(leaves, root, field)
		const index = entry.leaves.indexOf(aspLeaf(label))
		return index < 0 ? { state: "ABSENT" } : { state: "ACTIVE", path: entry.tree.path(index) }
	}

	private build(leaves: readonly bigint[], root: bigint, field: string): Entry {
		// Copied first: a caller's array edited during the build must not split the tree from its list.
		const own = [...leaves]
		const { onProgress } = this.opts
		const tree = buildLeanImt(own, onProgress ? { onProgress } : {})
		if (tree.root !== root) throw new SnapshotError("RootMismatch", field)
		this.trees.delete(root)
		for (const old of this.trees.keys()) if (this.trees.size >= this.maxTrees) this.trees.delete(old)
		const entry = { leaves: own, tree }
		this.trees.set(root, entry)
		return entry
	}
}
