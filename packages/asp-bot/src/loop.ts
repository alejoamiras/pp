import { buildLeanImt } from "@pp/bridge-spec"
import type { Hex, RootRecord } from "@pp/label-paths"
import { type Decision, decide, type L1Block, type PostArgs } from "./decide"
import type { SnapshotBook } from "./server"

/** The `checkpointed` Aztec block a tick pins: every registry read in the tick is at its hash. */
export type AztecTip = { number: number; hash: Hex; time: bigint }

/** What a tick reads and does; the live adapters wrap viem, the Aztec node, the ASP API and the wallet. */
export interface Ports {
	tip(): Promise<AztecTip>
	record(at: Hex): Promise<RootRecord>
	/** The registry's poster at `at`, as a field. */
	poster(at: Hex): Promise<bigint>
	selectL1(aztecTime: bigint): Promise<L1Block | null>
	/** `latestASPRoot()` at `e`; `null` while the association set is empty. */
	aspRootAt(e: L1Block): Promise<bigint | null>
	aspLeaves(): Promise<bigint[]>
	/** Approved birth leaves as of `tip`; empty until births are wired. */
	birthLeaves(tip: AztecTip): Promise<bigint[]>
	/** Sends `post_root` and resolves once it is checkpointed, with its block's time. */
	post(args: PostArgs): Promise<{ inclusionTime: bigint }>
	log(event: string, fields?: Record<string, unknown>): void
}

type Halt = "not_poster" | "no_l1_block" | "empty_set" | "asp_root_mismatch" | "size_mismatch"
/** `asp_deferred`: the leaves are needed but the request floor has not passed; not logged, since it repeats every tick. */
export type TickResult = Decision | { post: false; reason: Halt | "asp_deferred" | "error" }

type Pool = { root: bigint; leaves: bigint[] }

const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

const ROOT_MISMATCH = {
	why: "the ASP's leaves do not hash to the selected Ethereum block's root; around an update either side can lead",
	next: "nothing is posted and /latest keeps a snapshot this process holds; the bot asks the feed again on a later tick, no sooner than its request floor; if this persists, compare the API's leaves with the registry's root",
}

const SIZE_MISMATCH = {
	why: "a posted root now comes with a list of another length; one root has one honest list, so one of the two is collapsed",
	next: "the bot asks the feed again on a later tick, no sooner than its request floor, and resumes once the lengths agree; otherwise compare both lists with the ASP's published list: if the feed is wrong, fix it or restart the bot; if the posted length is wrong, fix the feed first, then the admin calls set_poster, which clears the record, and the bot posts again",
}

function sizeMismatch(record: RootRecord, pool: Pool, birthLeaves: bigint[], birthRoot: bigint): Record<string, unknown> | null {
	const lists = [
		{ list: "pool", root: pool.root, posted: record.poolRoot, postedSize: record.poolSize, size: pool.leaves.length },
		{ list: "birth", root: birthRoot, posted: record.birthRoot, postedSize: record.birthSize, size: birthLeaves.length },
	]
	for (const { list, root, posted, postedSize, size } of lists) {
		if (posted !== 0n && posted === root && postedSize !== BigInt(size)) return { list, root, postedSize, size, ...SIZE_MISMATCH }
	}
	return null
}

/** The poster's state lives in memory only: a restart rebuilds it from the chain and the ASP. */
export class Poster {
	private pool: Pool | null = null
	private lastReadTime: bigint | null = null
	private lastFetch = Number.NEGATIVE_INFINITY
	/** Whether the record was cleared as this process last saw it, its own posts included. */
	private cleared = false

	/**
	 * `leavesFloorMs` (default 0) is the least time between two leaves requests, counted from the start of
	 * each; `now` (default `performance.now`) must be monotonic.
	 */
	constructor(
		private readonly ports: Ports,
		private readonly book: SnapshotBook,
		private readonly opts: { self: bigint; inclusionMarginSec: bigint; leavesFloorMs?: number; now?: () => number },
	) {}

	/** One tick; the caller never runs two at once. A failed read or send is one log line and a skipped tick. */
	async tick(postNow = false): Promise<TickResult> {
		try {
			return await this.run(postNow)
		} catch (e) {
			this.ports.log("tick_failed", { error: e instanceof Error ? e.message : String(e) })
			return { post: false, reason: "error" }
		}
	}

	private async run(postNow: boolean): Promise<TickResult> {
		const p = this.ports
		const tip = await p.tip()
		const record = await p.record(tip.hash)
		// Before any other read can fail: after `set_poster` clears the roots, `/latest` must stop serving.
		this.book.setCurrent(record)
		const poster = await p.poster(tip.hash)
		if (poster !== this.opts.self) return this.halt("not_poster", { poster: `0x${poster.toString(16)}` })
		const e = await p.selectL1(tip.time)
		if (!e) return this.halt("no_l1_block", { aztecTime: tip.time })
		const root = await p.aspRootAt(e)
		if (root === null) return this.halt("empty_set", { l1Block: e.number })
		// A cleared record is the admin's reset: a list cached before it is fetched again, once; one fetched
		// since is kept, so a post the reset waits for never needs a second request.
		const cleared = record.poolRoot === 0n
		if (cleared && !this.cleared) this.pool = null
		this.cleared = cleared
		const pool = await this.poolFor(root)
		if (pool === "deferred") return { post: false, reason: "asp_deferred" }
		if (!pool) return { post: false, reason: "asp_root_mismatch" }
		const birthLeaves = (await p.birthLeaves(tip)).sort(ascending)
		const birthRoot = buildLeanImt(birthLeaves).root
		// The feed must not replace a length the record already holds for its root.
		const mismatch = sizeMismatch(record, pool, birthLeaves, birthRoot)
		if (mismatch) {
			// The cached list builds to the root, so only a fresh fetch can bring back the honest one.
			this.pool = null
			return this.halt("size_mismatch", mismatch)
		}
		this.holdCurrent(record, pool, birthLeaves, birthRoot)

		const d = decide({
			record,
			aztecTime: tip.time,
			e,
			poolRoot: root,
			birthRoot,
			poolSize: BigInt(pool.leaves.length),
			birthSize: BigInt(birthLeaves.length),
			lastReadTime: this.lastReadTime,
			postNow,
			inclusionMarginSec: this.opts.inclusionMarginSec,
		})
		if (!d.post) {
			if (d.reason !== "unchanged") p.log(d.reason, { sequence: record.sequence, l1Block: e.number })
			return d
		}
		// Held first: the record names the sequence once the post is proposed, before `post` resolves at the checkpoint.
		this.book.hold({ sequence: d.args.sequence, poolRoot: root, birthRoot, poolLeaves: pool.leaves, birthLeaves })
		const { inclusionTime } = await p.post(d.args)
		this.book.setCurrent(d.args)
		this.cleared = false
		this.lastReadTime = tip.time
		p.log("posted", { ...d.args, readTime: tip.time, inclusionTime, age: inclusionTime - d.args.rootTime })
		return d
	}

	/** A root already held reuses its leaves without asking the feed. */
	private async poolFor(root: bigint): Promise<Pool | "deferred" | null> {
		if (this.pool?.root === root) return this.pool
		const now = (this.opts.now ?? performance.now)()
		if (now - this.lastFetch < (this.opts.leavesFloorMs ?? 0)) return "deferred"
		// Before the request: an attempt that fails or times out uses the allowance too.
		this.lastFetch = now
		const leaves = await this.ports.aspLeaves()
		const aspRoot = buildLeanImt(leaves).root
		if (aspRoot !== root) {
			this.halt("asp_root_mismatch", { chainRoot: root, aspRoot, ...ROOT_MISMATCH })
			return null
		}
		this.pool = { root, leaves }
		return this.pool
	}

	/** Serves the current record when its roots and lengths are the lists this process holds, as after a restart. */
	private holdCurrent(record: RootRecord, pool: Pool, birthLeaves: bigint[], birthRoot: bigint): void {
		const ours =
			record.poolRoot === pool.root &&
			record.birthRoot === birthRoot &&
			record.poolSize === BigInt(pool.leaves.length) &&
			record.birthSize === BigInt(birthLeaves.length)
		if (record.sequence > 0n && ours && !this.book.has(record.sequence)) {
			this.book.hold({ sequence: record.sequence, poolRoot: pool.root, birthRoot, poolLeaves: pool.leaves, birthLeaves })
		}
		this.book.setCurrent(record)
	}

	private halt(reason: Halt, fields: Record<string, unknown>): TickResult {
		this.ports.log(reason, fields)
		return { post: false, reason }
	}
}
