/**
 * The fixture allow list: one posted record and its snapshot. Its leaves are the labels themselves
 * (the real tree hashes each), and its roots are stand-ins that are 0 for an empty list, as real ones.
 */
import type { LabelState, Origin } from "../stack-types"
import { BN254_P } from "../parse"
import type { AllowListPort, AllowListView } from "../ports"
import type { World } from "./world"

/** `@pp/label-paths`' limits: a proof anchored now must still find the record younger than its maximum age a spend window later. */
const MAX_ROOT_AGE = 3600n
const SPEND_WINDOW = 1800n

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

/** `@pp/label-paths`' `labelState` over the fixture tree: roots compared, the same age cutoff, then the label's leaf. */
export function stateIn(view: AllowListView, label: bigint, origin: Origin, nowSec: bigint): LabelState {
	const { record: r, snapshot: s } = view
	if (s.poolRoot !== r.poolRoot || s.birthRoot !== r.birthRoot) return "STALE_ROOT"
	if (r.rootTime > nowSec || r.rootTime + MAX_ROOT_AGE < nowSec + SPEND_WINDOW) return "STALE_ROOT"
	return (origin === 0 ? s.poolLeaves : s.birthLeaves).includes(label) ? "ACTIVE" : "ABSENT"
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
