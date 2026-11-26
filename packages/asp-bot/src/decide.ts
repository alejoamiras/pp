import { type Hex, MAX_OBSERVATION_LAG, type RootRecord } from "@pp/label-paths"

/** Re-post unchanged roots once this much Aztec chain time has passed since the last landed post's read. */
export const HEARTBEAT_SEC = 300n

const U64_LIMIT = 2n ** 64n

/** An Ethereum block header, as selected for a post. */
export type L1Block = { number: bigint; hash: Hex; timestamp: bigint }

export type DecideInput = {
	/** The registry's record at the pinned Aztec block. */
	record: RootRecord
	/** That Aztec block's timestamp, `A`. */
	aztecTime: bigint
	e: L1Block
	/** `latestASPRoot()` at `e`. */
	poolRoot: bigint
	birthRoot: bigint
	/** The read time `A` of this process's last landed post; `null` before its first. */
	lastReadTime: bigint | null
	postNow: boolean
	inclusionMarginSec: bigint
}

export type PostArgs = { sequence: bigint; poolRoot: bigint; birthRoot: bigint; l1Block: bigint; rootTime: bigint }

export type SkipReason =
	| "unchanged"
	| "no_newer_block"
	| "zero_pool_root"
	| "record_ahead"
	| "root_time_regressed"
	| "new_time_on_same_block"
	| "root_time_in_future"
	| "lag"
	| "sequence_overflow"

export type Decision = { post: true; args: PostArgs } | { post: false; reason: SkipReason }

const skip = (reason: SkipReason): Decision => ({ post: false, reason })

/** Whether to post, by the roots and by chain time; never by wall time, which a frozen local chain ignores. */
function wanted(i: DecideInput): Decision | null {
	const newer = i.e.number > i.record.l1Block
	if (i.postNow) return newer ? null : skip("no_newer_block")
	if (i.poolRoot !== i.record.poolRoot || i.birthRoot !== i.record.birthRoot) return null
	// A heartbeat on the same Ethereum block keeps `root_time`, so it would refresh nothing.
	const due = i.lastReadTime === null || i.aztecTime - i.lastReadTime >= HEARTBEAT_SEC
	return newer && due ? null : skip("unchanged")
}

/** The registry's `post_root` assertions (`asp_registry/src/main.nr`), so a post never reverts for a reason checked here. */
function refused(i: DecideInput): SkipReason | null {
	const { record: r, e } = i
	if (r.sequence + 1n >= U64_LIMIT) return "sequence_overflow"
	if (i.poolRoot === 0n) return "zero_pool_root"
	if (e.number < r.l1Block) return "record_ahead"
	if (e.timestamp < r.rootTime) return "root_time_regressed"
	if (e.number === r.l1Block && e.timestamp !== r.rootTime) return "new_time_on_same_block"
	if (e.timestamp > i.aztecTime) return "root_time_in_future"
	// The inclusion block's time, not the read's, is what the contract checks.
	if (i.aztecTime + i.inclusionMarginSec - e.timestamp > MAX_OBSERVATION_LAG) return "lag"
	return null
}

export function decide(i: DecideInput): Decision {
	const no = wanted(i)
	if (no) return no
	const reason = refused(i)
	if (reason) return skip(reason)
	return {
		post: true,
		args: {
			sequence: i.record.sequence + 1n,
			poolRoot: i.poolRoot,
			birthRoot: i.birthRoot,
			l1Block: i.e.number,
			rootTime: i.e.timestamp,
		},
	}
}
