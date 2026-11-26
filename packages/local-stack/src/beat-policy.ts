export type L1Tx = { from: string; to: string | null }
export type AztecTips = { checkpointed: { number: number; hash: string }; proven: number }

export type ChainView = {
	l1Head(): Promise<bigint>
	/** Block `n`'s hash; a revert that replaces the block changes it. */
	l1Hash(n: bigint): Promise<string>
	/** Block `n`'s transactions as lower-case sender and target; empty for an empty block. */
	l1Txs(n: bigint): Promise<readonly L1Tx[]>
	aztecTips(): Promise<AztecTips>
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
 * node's account still counts as work. An owed beat waits until the newest block is proven: the
 * node proves everything checkpointed in one L1 block, so a block proven together with its
 * follow-up is not finalized by it.
 */
export class BeatPolicy {
	private scanned = 0n
	private scannedHash = ""
	private ownTip = { number: 0, hash: "" }
	private owed = 0

	constructor(
		private readonly view: ChainView,
		/** The node's propose transaction: its publisher and the contract it calls, lower-case. */
		private readonly nodeTx: L1Tx,
	) {}

	/** Call right after the readiness beat: the pool's deploy owes two beats and that was the first. */
	async start(): Promise<void> {
		this.scanned = await this.view.l1Head()
		this.scannedHash = await this.view.l1Hash(this.scanned)
		this.ownTip = (await this.view.aztecTips()).checkpointed
		this.owed = 1
	}

	async due(): Promise<boolean> {
		const head = await this.view.l1Head()
		// Read before the scan, so a revert during it shows as a mismatch on the next tick.
		const headHash = await this.view.l1Hash(head)
		if ((await this.replaced(head)) || (await this.foreignSince(this.scanned, head))) this.owed = 2
		this.scanned = head
		this.scannedHash = headHash
		const tips = await this.view.aztecTips()
		if (tips.checkpointed.hash !== this.ownTip.hash) this.owed = Math.max(this.owed, 1)
		return this.owed > 0 && tips.proven >= tips.checkpointed.number
	}

	/**
	 * One beat: `mine` must return once its block is checkpointed. Anything besides one empty block
	 * of ours (a user transaction it picked up, a block another caller built meanwhile) leaves a beat
	 * owed; a failed read leaves the debt as it was. A block that landed unproven since `due()` is
	 * left to its proof first, without mining.
	 */
	async beat(mine: () => Promise<unknown>): Promise<void> {
		const pre = await this.view.aztecTips()
		if (pre.proven < pre.checkpointed.number) return
		const before = pre.checkpointed.number
		await mine()
		const tip = (await this.view.aztecTips()).checkpointed
		const clean = tip.number === before + 1 && !(await this.view.aztecHasTxs(tip.number))
		this.owed = clean ? Math.max(0, this.owed - 1) : Math.max(1, this.owed - 1)
		this.ownTip = tip
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
