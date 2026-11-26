/**
 * The fixture allow list: one posted record and its snapshot. Its leaves are the labels themselves
 * (the real tree hashes each), and its roots are stand-ins that are 0 for an empty list, as real ones.
 */
import type { LabelState, Origin } from "../a7"
import { BN254_P } from "../parse"
import type { AllowListPort, AllowListView } from "../ports"
import type { World } from "./world"

/** `@pp/label-paths`' MAX_ROOT_AGE: a record older than this, in chain time, is too old to spend against. */
export const MAX_ROOT_AGE = 3600n

const rootOf = (leaves: readonly bigint[]) => (leaves.length === 0 ? 0n : (leaves.reduce((a, b) => a * 31n + b, 7n) % (BN254_P - 1n)) + 1n)

function current(w: World): AllowListView {
	const a = w.s.allowList
	const poolRoot = rootOf(a.pool)
	const birthRoot = rootOf(a.birth)
	return {
		record: { sequence: a.sequence, poolRoot, birthRoot, l1Block: a.l1Block, rootTime: a.rootTime },
		snapshot: {
			sequence: a.sequence,
			poolRoot,
			birthRoot,
			poolLeaves: [...a.pool],
			birthLeaves: [...a.birth].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
		},
	}
}

/** `labelState` for the fixture tree: stale past MAX_ROOT_AGE, else whether the origin's tree holds the label. */
export function stateIn(view: AllowListView, label: bigint, origin: Origin, nowSec: bigint): LabelState {
	if (view.record.sequence !== view.snapshot.sequence || nowSec > view.record.rootTime + MAX_ROOT_AGE) return "STALE_ROOT"
	return (origin === 0 ? view.snapshot.poolLeaves : view.snapshot.birthLeaves).includes(label) ? "ACTIVE" : "ABSENT"
}

/** The state a checked spend sees now, at the latest Aztec block. */
export const fixtureLabelState = (w: World, label: bigint, origin: Origin): LabelState => stateIn(current(w), label, origin, w.aztecTime())

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
	return { current: async () => current(w), state: stateIn }
}
