export type L1Tx = { from: string; to: string | null }

/** The chain reads the policy needs; structural, so tests pass a fake. */
export type ChainView = {
	l1Head(): Promise<bigint>
	/** Block `n`'s transactions as lower-case sender and target; empty for an empty block. */
	l1Txs(n: bigint): Promise<readonly L1Tx[]>
	/** Number of the newest checkpointed Aztec block. */
	aztecTip(): Promise<number>
}

/**
 * Decides whether a heartbeat tick should mine. Chain time on the stack moves only with blocks
 * (L1 +12 s each, an Aztec block jumps to the next 72 s slot), so an idle stack stays frozen and a
 * beat is owed only to work that waits on blocks:
 * - an L1 transaction other than the node's propose owes two beats: a block built before the node
 *   has read an L1→L2 message misses it, and the second beat carries it;
 * - an Aztec block the heartbeat did not mine owes one beat, the block that finalizes it.
 * The node's own L1 blocks (each beat's propose and the empty proof block after it) owe nothing. A
 * node transaction is matched by sender and target together, so another actor sending from the
 * node's account still counts as work.
 */
export class BeatPolicy {
	private scanned = 0n
	private ownTip = 0
	private owed = 0

	constructor(
		private readonly view: ChainView,
		/** The node's propose transaction: its publisher and the contract it calls, lower-case. */
		private readonly nodeTx: L1Tx,
	) {}

	/**
	 * Call right after the first beat. The boot itself moved L1 (the pool's deploy), and that beat
	 * was only the first of the two it owes.
	 */
	async start(): Promise<void> {
		this.scanned = await this.view.l1Head()
		this.ownTip = await this.view.aztecTip()
		this.owed = 1
	}

	async due(): Promise<boolean> {
		const head = await this.view.l1Head()
		if (await this.foreignSince(this.scanned, head)) this.owed = 2
		this.scanned = head
		if ((await this.view.aztecTip()) > this.ownTip) this.owed = Math.max(this.owed, 1)
		return this.owed > 0
	}

	/** Call after a beat's block is checkpointed. */
	async beaten(): Promise<void> {
		this.owed = Math.max(0, this.owed - 1)
		this.ownTip = await this.view.aztecTip()
	}

	/** Newest first, so a busy chain answers on its first block. */
	private async foreignSince(after: bigint, head: bigint): Promise<boolean> {
		for (let n = head; n > after; n--) {
			if ((await this.view.l1Txs(n)).some((t) => t.from !== this.nodeTx.from || t.to !== this.nodeTx.to)) return true
		}
		return false
	}
}
