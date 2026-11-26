export type L1Tx = { from: string; to: string | null }

/** The chain reads the policy needs. */
export type ChainView = {
	l1Head(): Promise<bigint>
	/** Block `n`'s hash; a revert that replaces the block changes it. */
	l1Hash(n: bigint): Promise<string>
	/** Block `n`'s transactions as lower-case sender and target; empty for an empty block. */
	l1Txs(n: bigint): Promise<readonly L1Tx[]>
	/** Number of the newest checkpointed Aztec block. */
	aztecTip(): Promise<number>
	/** Whether Aztec block `n` carries any transaction. */
	aztecHasTxs(n: number): Promise<boolean>
}

/**
 * Decides whether a heartbeat tick should mine. Chain time on the stack moves only with blocks
 * (L1 +12 s each, an Aztec block jumps to the next 72 s slot), so an idle stack stays frozen and a
 * beat is owed only to work that waits on blocks:
 * - an L1 transaction other than the node's propose, or a revert, owes two beats: a block built
 *   before the node has read an L1→L2 message misses it, and the second beat carries it;
 * - an Aztec block that carries transactions or that the heartbeat did not mine owes one beat, the
 *   block that finalizes it.
 * The node's own L1 blocks (each beat's propose and the empty proof block after it) owe nothing. A
 * node transaction is matched by sender and target together, so another actor sending from the
 * node's account still counts as work.
 */
export class BeatPolicy {
	private scanned = 0n
	private scannedHash = ""
	private ownTip = 0
	private owed = 0

	constructor(
		private readonly view: ChainView,
		/** The node's propose transaction: its publisher and the contract it calls, lower-case. */
		private readonly nodeTx: L1Tx,
	) {}

	/** Call right after the readiness beat: the pool's deploy owes two beats and that was the first. */
	async start(): Promise<void> {
		await this.mark(await this.view.l1Head())
		this.ownTip = await this.view.aztecTip()
		this.owed = 1
	}

	async due(): Promise<boolean> {
		const head = await this.view.l1Head()
		if ((await this.replaced(head)) || (await this.foreignSince(this.scanned, head))) this.owed = 2
		await this.mark(head)
		if ((await this.view.aztecTip()) !== this.ownTip) this.owed = Math.max(this.owed, 1)
		return this.owed > 0
	}

	/**
	 * One beat: `mine` must return once its block is checkpointed. Anything besides one empty block
	 * of ours (a user transaction it picked up, a block another caller built meanwhile) leaves a beat
	 * owed; a failed read leaves the debt as it was.
	 */
	async beat(mine: () => Promise<unknown>): Promise<void> {
		const before = await this.view.aztecTip()
		await mine()
		const tip = await this.view.aztecTip()
		const clean = tip === before + 1 && !(await this.view.aztecHasTxs(tip))
		this.owed = clean ? Math.max(0, this.owed - 1) : Math.max(1, this.owed - 1)
		this.ownTip = tip
	}

	private async mark(head: bigint): Promise<void> {
		this.scannedHash = await this.view.l1Hash(head)
		this.scanned = head
	}

	private async replaced(head: bigint): Promise<boolean> {
		return head < this.scanned || (await this.view.l1Hash(this.scanned)) !== this.scannedHash
	}

	/** Newest first, so a busy chain answers on its first block. */
	private async foreignSince(after: bigint, head: bigint): Promise<boolean> {
		for (let n = head; n > after; n--) {
			if ((await this.view.l1Txs(n)).some((t) => t.from !== this.nodeTx.from || t.to !== this.nodeTx.to)) return true
		}
		return false
	}
}
