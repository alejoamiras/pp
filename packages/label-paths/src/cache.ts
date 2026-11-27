import { aspLeaf, buildLeanImt, type LabelPath, type LeanImt } from "@pp/bridge-spec"
import { type AspSnapshot, MAX_ROOT_AGE, type Origin, type RootRecord, SnapshotError, SPEND_WINDOW, treeOf } from "./snapshot"

/**
 * `STALE_ROOT` says what to do next: `snapshot` (its roots are not the record's) means fetch the
 * record's own sequence; `age` (the record's roots are too old for a spend) means wait for the next post.
 */
export type LabelCheck = { state: "ACTIVE"; path: LabelPath } | { state: "ABSENT" } | { state: "STALE_ROOT"; reason: "snapshot" | "age" }

export type LabelPathCacheOptions = {
	/** Runs after each hash of a tree build, with that build's exact total; a Worker can forward it. */
	onProgress?: (hashed: number, total: number) => void
	/** Verified trees kept; default 2, one per origin. */
	maxTrees?: number
}

type Entry = { leaves: readonly bigint[]; tree: LeanImt }

/**
 * `labelState` and `pathFor` in one call, for snapshots from `parseAspSnapshotUnverified`. It compares
 * the declared roots with the record before any hash, builds a tree only for a label found in its
 * origin's list, and keeps each verified tree by root, so a later record with the same root (a
 * heartbeat) reuses it. Trees whose root the record has left are dropped. Pure: no I/O.
 */
export class LabelPathCache {
	private readonly trees = new Map<bigint, Entry>()

	constructor(private readonly opts: LabelPathCacheOptions = {}) {
		const max = opts.maxTrees
		if (max !== undefined && !(Number.isSafeInteger(max) && max >= 1))
			throw new RangeError(`maxTrees must be a positive integer: ${max}`)
	}

	/**
	 * Same rules as `labelState`; `r` is the record at the anchor block and `nowSec` its time plus the
	 * proving budget. Throws `SnapshotError("RootMismatch")` when a found label's list does not build to
	 * the declared root: the server lied, and nothing is kept.
	 */
	check(r: RootRecord, s: AspSnapshot, label: bigint, origin: Origin, nowSec: bigint): LabelCheck {
		for (const root of this.trees.keys()) if (root !== r.poolRoot && root !== r.birthRoot) this.trees.delete(root)
		if (s.poolRoot !== r.poolRoot || s.birthRoot !== r.birthRoot) return { state: "STALE_ROOT", reason: "snapshot" }
		if (r.rootTime > nowSec || r.rootTime + MAX_ROOT_AGE < nowSec + SPEND_WINDOW) return { state: "STALE_ROOT", reason: "age" }
		const { leaves, root, field } = treeOf(s, origin)
		if (root === 0n) return { state: "ABSENT" }
		const cached = this.trees.get(root)
		// A cached root's leaves are the verified ones; a snapshot claiming the same root cannot replace them.
		const index = (cached?.leaves ?? leaves).indexOf(aspLeaf(label))
		if (index < 0) return { state: "ABSENT" }
		const entry = cached ?? this.build(leaves, root, field)
		return { state: "ACTIVE", path: entry.tree.path(index) }
	}

	private build(leaves: readonly bigint[], root: bigint, field: string): Entry {
		const { onProgress } = this.opts
		const tree = buildLeanImt(leaves, onProgress ? { onProgress } : {})
		if (tree.root !== root) throw new SnapshotError("RootMismatch", field)
		const max = this.opts.maxTrees ?? 2
		for (const old of this.trees.keys()) if (this.trees.size >= max) this.trees.delete(old)
		const entry = { leaves: [...leaves], tree }
		this.trees.set(root, entry)
		return entry
	}
}
