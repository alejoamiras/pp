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

type Halt = "not_poster" | "no_l1_block" | "empty_set" | "asp_root_mismatch"
export type TickResult = Decision | { post: false; reason: Halt | "error" }

type Pool = { root: bigint; leaves: bigint[] }

const ascending = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0)

/** The poster's state lives in memory only: a restart rebuilds it from the chain and the ASP. */
export class Poster {
	private pool: Pool | null = null
	private lastReadTime: bigint | null = null

	constructor(
		private readonly ports: Ports,
		private readonly book: SnapshotBook,
		private readonly opts: { self: bigint; inclusionMarginSec: bigint },
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
		const [record, poster] = await Promise.all([p.record(tip.hash), p.poster(tip.hash)])
		if (poster !== this.opts.self) return this.halt("not_poster", { poster: `0x${poster.toString(16)}` })
		const e = await p.selectL1(tip.time)
		if (!e) return this.halt("no_l1_block", { aztecTime: tip.time })
		const root = await p.aspRootAt(e)
		if (root === null) return this.halt("empty_set", { l1Block: e.number })
		const pool = await this.poolFor(root)
		if (!pool) return { post: false, reason: "asp_root_mismatch" }
		const birthLeaves = (await p.birthLeaves(tip)).sort(ascending)
		const birthRoot = buildLeanImt(birthLeaves).root
		this.holdCurrent(record, pool, birthLeaves, birthRoot)

		const d = decide({
			record,
			aztecTime: tip.time,
			e,
			poolRoot: root,
			birthRoot,
			lastReadTime: this.lastReadTime,
			postNow,
			inclusionMarginSec: this.opts.inclusionMarginSec,
		})
		if (!d.post) {
			if (d.reason !== "unchanged") p.log(d.reason, { sequence: record.sequence, l1Block: e.number })
			return d
		}
		const { inclusionTime } = await p.post(d.args)
		this.book.hold({ sequence: d.args.sequence, poolRoot: root, birthRoot, poolLeaves: pool.leaves, birthLeaves })
		this.book.setCurrent(d.args)
		this.lastReadTime = tip.time
		p.log("posted", { ...d.args, readTime: tip.time, inclusionTime, age: inclusionTime - d.args.rootTime })
		return d
	}

	/** The leaves for the chain's `root`: kept from memory, or fetched and kept only if they hash to it. */
	private async poolFor(root: bigint): Promise<Pool | null> {
		if (this.pool?.root === root) return this.pool
		const leaves = await this.ports.aspLeaves()
		const aspRoot = buildLeanImt(leaves).root
		if (aspRoot !== root) {
			this.halt("asp_root_mismatch", { chainRoot: root, aspRoot })
			return null
		}
		this.pool = { root, leaves }
		return this.pool
	}

	/** Serves the current record when its roots are the ones this process holds, as after a restart. */
	private holdCurrent(record: RootRecord, pool: Pool, birthLeaves: bigint[], birthRoot: bigint): void {
		const ours = record.poolRoot === pool.root && record.birthRoot === birthRoot
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
