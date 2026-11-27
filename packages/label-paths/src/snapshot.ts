import { aspLeaf, BN254_P, buildLeanImt, type LabelPath, MAX_DEPTH } from "@pp/bridge-spec"

/** The leaf sets behind one registry record. Leaves are tree leaves, `hash_1(label)`, as the ASP serves them. */
export type AspSnapshot = { sequence: bigint; poolRoot: bigint; birthRoot: bigint; poolLeaves: bigint[]; birthLeaves: bigint[] }

/** The registry's `RootRecord`, field for field. */
export type RootRecord = { sequence: bigint; poolRoot: bigint; birthRoot: bigint; l1Block: bigint; rootTime: bigint }

/**
 * One snapshot cannot tell a never-approved label from a removed one, so both are `ABSENT`. The record
 * binds the roots, not the lists' lengths, so `ABSENT` is not proof that a label is unapproved.
 */
export type LabelState = "ACTIVE" | "ABSENT" | "STALE_ROOT"

/** The note's origin: 0 = minted from the bridge (pool tree), 1 = shielded (birth tree). Never a fallback search. */
export type Origin = 0 | 1

// Mirrors of `asp_registry/src/label_check.nr`, pinned to it by a test.
export const MAX_OBSERVATION_LAG = 1800n
export const MAX_ROOT_AGE = 3600n
export const SPEND_WINDOW = 1800n
export const MAX_LEAVES = 2 ** MAX_DEPTH

export type SnapshotErrorCode = "Malformed" | "OutOfRange" | "TooManyLeaves" | "UnsortedBirthLeaves" | "RootMismatch"

export class SnapshotError extends Error {
	constructor(
		readonly code: SnapshotErrorCode,
		readonly field: string,
	) {
		super(`${code}: ${field}`)
		this.name = "SnapshotError"
	}
}

const U64_LIMIT = 2n ** 64n

function checkLeaves(leaves: readonly bigint[], field: string): void {
	if (leaves.length > MAX_LEAVES) throw new SnapshotError("TooManyLeaves", field)
	for (const [i, leaf] of leaves.entries()) {
		if (typeof leaf !== "bigint" || leaf <= 0n || leaf >= BN254_P) throw new SnapshotError("OutOfRange", `${field}[${i}]`)
	}
}

/** Every check of `verifySnapshot` but the roots; builds no tree. */
export function checkSnapshotFields(s: AspSnapshot): void {
	if (s.sequence < 1n || s.sequence >= U64_LIMIT) throw new SnapshotError("OutOfRange", "sequence")
	checkLeaves(s.poolLeaves, "poolLeaves")
	checkLeaves(s.birthLeaves, "birthLeaves")
	for (let i = 1; i < s.birthLeaves.length; i++) {
		if ((s.birthLeaves[i - 1] as bigint) >= (s.birthLeaves[i] as bigint))
			throw new SnapshotError("UnsortedBirthLeaves", `birthLeaves[${i}]`)
	}
}

/**
 * Throws a `SnapshotError` unless each root is the LeanIMT root of its leaves (0 for an empty list),
 * every leaf is in [1, p), each list has at most `MAX_LEAVES`, and birth leaves are strictly ascending.
 */
export function verifySnapshot(s: AspSnapshot): void {
	checkSnapshotFields(s)
	if (buildLeanImt(s.poolLeaves).root !== s.poolRoot) throw new SnapshotError("RootMismatch", "poolRoot")
	if (buildLeanImt(s.birthLeaves).root !== s.birthRoot) throw new SnapshotError("RootMismatch", "birthRoot")
}

export function treeOf(s: AspSnapshot, origin: Origin): { leaves: readonly bigint[]; root: bigint; field: string } {
	if (origin === 0) return { leaves: s.poolLeaves, root: s.poolRoot, field: "poolRoot" }
	if (origin === 1) return { leaves: s.birthLeaves, root: s.birthRoot, field: "birthRoot" }
	throw new SnapshotError("OutOfRange", "origin")
}

/**
 * The label's path in its origin's tree only, or `null` when its leaf is not there. The index is found
 * by value, since a revocation shifts every later leaf. Once the leaf is found, throws if the tree does not
 * rebuild to its root. A `null` is sound only for a verified snapshot (`parseAspSnapshot`): an unverified
 * list was never checked against its root.
 */
export function pathFor(s: AspSnapshot, label: bigint, origin: Origin): LabelPath | null {
	const { leaves, root, field } = treeOf(s, origin)
	const index = leaves.indexOf(aspLeaf(label))
	if (index < 0) return null
	const tree = buildLeanImt(leaves)
	if (tree.root !== root) throw new SnapshotError("RootMismatch", field)
	return tree.path(index)
}

/**
 * `check_label`'s time rule: whether `r`'s roots may still be spent against at `nowSec`, with the same
 * anchor time plus proving budget `labelState` takes. Needs no snapshot.
 */
export function rootFresh(r: Pick<RootRecord, "rootTime">, nowSec: bigint): boolean {
	return r.rootTime <= nowSec && r.rootTime + MAX_ROOT_AGE >= nowSec + SPEND_WINDOW
}

/**
 * Mirrors `check_label`. `r` must be the record at the block the proof will anchor to, and `nowSec`
 * that block's timestamp. Roots are compared, not `sequence`: a heartbeat keeps both roots and every path.
 * `ACTIVE` at the exact age limit fails a proof anchored one block later, so pass the anchor time plus
 * the proving budget. Pass a verified snapshot (`parseAspSnapshot`): on an unverified one, `ABSENT` comes
 * from a list never checked against its root. `LabelPathCache.check` takes an unverified one.
 */
export function labelState(r: RootRecord, s: AspSnapshot, label: bigint, origin: Origin, nowSec: bigint): LabelState {
	if (s.poolRoot !== r.poolRoot || s.birthRoot !== r.birthRoot) return "STALE_ROOT"
	if (!rootFresh(r, nowSec)) return "STALE_ROOT"
	if (treeOf(s, origin).root === 0n) return "ABSENT"
	return pathFor(s, label, origin) === null ? "ABSENT" : "ACTIVE"
}
