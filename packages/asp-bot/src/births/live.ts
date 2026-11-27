import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type EventCursor, getPublicEvents } from "@aztec-labs/aztec.js/events"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { TxExecutionResult, TxHash } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { BirthAnnouncement, BirthTx, ShieldDebited } from "./check"
import { eventMeta } from "./events"
import type { BirthSource } from "./reader"

type RawDebit = { birth_id: bigint; owner: AztecAddress; amount: bigint }

/**
 * The intake's births through the bot's PXE, which holds the intake's keys and the tokens'
 * instances, and through the node. `syncedBlock` must sync that same PXE.
 */
export async function liveBirthSource(o: {
	wallet: Wallet
	node: AztecNode
	intake: AztecAddress
	artifact: ContractArtifact
	syncedBlock(): Promise<number>
	blockHash(number: number): Promise<string>
}): Promise<BirthSource> {
	const [announced, debited] = await Promise.all([eventMeta(o.artifact, "BirthAnnouncement"), eventMeta(o.artifact, "ShieldDebited")])
	return {
		syncedBlock: o.syncedBlock,
		blockHash: o.blockHash,
		async announcements(token, toBlock) {
			const found = await o.wallet.getPrivateEvents<BirthAnnouncement>(announced, {
				contractAddress: token,
				scopes: [o.intake],
				// Exclusive.
				toBlock: BlockNumber(toBlock + 1),
			})
			return found.map((f) => ({ event: f.event, txHash: f.metadata.txHash.toString() }))
		},
		async tx(token, txHash): Promise<BirthTx> {
			const hash = TxHash.fromString(txHash)
			const receipt = await o.node.getTxReceipt(hash, { includeTxEffect: true })
			const debits: ShieldDebited[] = []
			// A page holds at most 20 events, and one transaction can shield more often than that.
			let afterEvent: EventCursor | undefined
			do {
				const page = await getPublicEvents<RawDebit>(o.node, debited, { contractAddress: token, txHash: hash, afterEvent })
				for (const { event: e } of page.events) debits.push({ birthId: e.birth_id, owner: e.owner, amount: e.amount })
				afterEvent = page.nextCursor
			} while (afterEvent)
			return {
				success: receipt.executionResult === TxExecutionResult.SUCCESS,
				block: receipt.blockNumber ?? Number.POSITIVE_INFINITY,
				nullifiers: (receipt.txEffect?.nullifiers ?? []).map((n) => n.toBigInt()),
				debits,
			}
		},
	}
}
