/**
 * The fixture allow list: one posted record and its snapshot. Its leaves are the labels themselves
 * (the real tree hashes each), and its roots are stand-ins that are 0 for an empty list, as real ones.
 * A check answers at once and builds no tree, so its path is a placeholder.
 */
import type { AspSnapshot, LabelCheck, LabelState, Origin, RootRecord } from "../stack-types"
import { BN254_P } from "../parse"
import type { AllowListPort } from "../ports"
import type { World } from "./world"

/** `@pp/label-paths`' limits: a proof anchored now must still find the record younger than its maximum age a spend window later. */
const MAX_ROOT_AGE = 3600n
const SPEND_WINDOW = 1800n

const rootOf = (leaves: readonly bigint[]) => (leaves.length === 0 ? 0n : (leaves.reduce((a, b) => a * 31n + b, 7n) % (BN254_P - 1n)) + 1n)

interface Posted {
	record: RootRecord
	snapshot: AspSnapshot
}

function posted(w: World): Posted {
	const a = w.s.allowList
	const poolRoot = rootOf(a.pool)
	const birthRoot = rootOf(a.birth)
	return {
		record: {
			sequence: a.sequence,
			poolRoot,
			birthRoot,
			l1Block: a.l1Block,
			rootTime: a.rootTime,
			poolSize: BigInt(a.pool.length),
			birthSize: BigInt(a.birth.length),
		},
		snapshot: {
			sequence: a.sequence,
			poolRoot,
			birthRoot,
			poolLeaves: [...a.pool],
			birthLeaves: [...a.birth].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
		},
	}
}

/** `@pp/label-paths`' `LabelPathCache.check` over the fixture tree: roots compared, the same age cutoff, then the label's leaf. */
function checkIn({ record: r, snapshot: s }: Posted, label: bigint, origin: Origin, nowSec: bigint): LabelCheck {
	if (s.poolRoot !== r.poolRoot || s.birthRoot !== r.birthRoot) return { state: "STALE_ROOT", reason: "snapshot" }
	if (r.rootTime > nowSec || r.rootTime + MAX_ROOT_AGE < nowSec + SPEND_WINDOW) return { state: "STALE_ROOT", reason: "age" }
	const index = (origin === 0 ? s.poolLeaves : s.birthLeaves).indexOf(label)
	return index < 0 ? { state: "ABSENT" } : { state: "ACTIVE", path: { index, depth: 0, siblings: [] } }
}

/** The state a checked spend sees now, at the latest Aztec block. */
export const fixtureLabelState = (w: World, label: bigint, origin: Origin): LabelState =>
	checkIn(posted(w), label, origin, w.aztecTime()).state

/** Posts a new record that adds every pending shield's label to the birth tree. */
export function approveBirths(w: World): void {
	w.update((s) => {
		const a = s.allowList
		a.birth = [...a.birth, ...a.pendingBirths.filter((l) => !a.birth.includes(l))]
		a.pendingBirths = []
		a.sequence++
		a.rootTime = w.aztecTime()
		a.l1Block = BigInt(s.l1Block)
	})
}

export function fixtureAllowList(w: World): AllowListPort {
	return {
		current: async () => ({ record: posted(w).record, nowSec: w.aztecTime() }),
		// The snapshot is the world's list now, which a view read before a post no longer names.
		check: async (view, label, origin) => checkIn({ ...posted(w), record: view.record }, label, origin, view.nowSec),
		onProgress: () => () => {},
		cancel() {},
		checkAgain: () => true,
	}
}
