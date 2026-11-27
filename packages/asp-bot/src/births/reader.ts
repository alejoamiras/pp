import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type BirthAnnouncement, type BirthTx, checkBirth } from "./check"

export type FoundBirth = { event: BirthAnnouncement; txHash: string }

/** The intake's view of births, through its PXE and the node. */
export interface BirthSource {
	/** Syncs the intake's PXE and returns the block it now reads at; its anchor never moves back short of a reorg. */
	syncedBlock(): Promise<number>
	/** Every announcement `token` sent the intake in blocks `[1, toBlock]`. */
	announcements(token: AztecAddress, toBlock: number): Promise<FoundBirth[]>
	tx(token: AztecAddress, txHash: string): Promise<BirthTx>
}

/**
 * Rebuilds the approved birth set from the intake's PXE on every read, so a restart or a
 * `set_poster` loses nothing. Logs carry a transaction hash and a reason, never an announced field.
 */
export class BirthReader {
	private readonly refused = new Set<string>()

	constructor(
		private readonly src: BirthSource,
		private readonly tokens: readonly AztecAddress[],
		private readonly log: (event: string, fields: Record<string, unknown>) => void,
	) {}

	/** Approved leaves as of `pin`, unique. Throws while the PXE is behind `pin`: a partial set would drop births from the next root. */
	async leaves(pin: number): Promise<bigint[]> {
		const synced = await this.src.syncedBlock()
		if (synced < pin) throw new Error(`intake PXE at block ${synced}, behind the pinned block ${pin}`)
		const leaves = new Set<bigint>()
		for (const token of this.tokens) {
			const txs = new Map<string, Promise<BirthTx>>()
			for (const f of await this.src.announcements(token, pin)) {
				const tx = txs.get(f.txHash) ?? this.src.tx(token, f.txHash)
				txs.set(f.txHash, tx)
				const v = await checkBirth(token, pin, f.event, await tx)
				if (v.ok) leaves.add(v.leaf)
				else this.refuse(f.txHash, v.reason)
			}
		}
		return [...leaves]
	}

	private refuse(txHash: string, reason: string): void {
		const key = `${txHash}:${reason}`
		if (this.refused.has(key)) return
		this.refused.add(key)
		this.log("birth_refused", { txHash, reason })
	}
}
