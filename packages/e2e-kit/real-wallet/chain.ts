/**
 * What a sent transaction did, read from the stack's own node rather than the recorder in front of it,
 * so the reads never enter the wallet's record.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type AztecNode, createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { ProtocolContractAddress } from "@aztec-labs/aztec.js/protocol"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { computeFeePayerBalanceLeafSlot, computeFeePayerBalanceStorageSlot } from "@aztec-labs/protocol-contracts/fee-juice"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { TxExecutionResult, TxHash } from "@aztec-labs/stdlib/tx"
import { sponsoredFpcAddress } from "@pp/bridge-core"

export interface SentTx {
	hash: string
	succeeded: boolean
	block: number
	fee: bigint
	nullifiers: string[]
}

export interface Sponsorship {
	/** The SponsoredFPC's Fee Juice balance at the block before the transaction's. */
	before: bigint
	/** What the transaction's effect wrote to that balance's leaf; `undefined` when it wrote none. */
	written: bigint | undefined
	fee: bigint
}

export interface Chain {
	node: AztecNode
	sentTx(hash: string): Promise<SentTx>
	hasWitness(nullifier: string): Promise<boolean>
	feeJuice(address: string): Promise<bigint>
	sponsorFeeJuice(): Promise<bigint>
	sponsorship(tx: SentTx): Promise<Sponsorship>
}

export function chainAt(nodeUrl: string): Chain {
	const node = createAztecNodeClient(nodeUrl)
	const effectOf = async (hash: string) => {
		const effect = await node.getTxEffect(TxHash.fromString(hash))
		if (!effect) throw new Error(`chain: the node has no effect for ${hash}`)
		return effect
	}
	return {
		node,
		async sentTx(hash) {
			const receipt = await node.getTxReceipt(TxHash.fromString(hash))
			const { data, l2BlockNumber } = await effectOf(hash)
			return {
				hash,
				succeeded: receipt.executionResult === TxExecutionResult.SUCCESS,
				block: Number(l2BlockNumber),
				fee: data.transactionFee.toBigInt(),
				nullifiers: data.nullifiers.map((n) => n.toString()),
			}
		},
		async hasWitness(nullifier) {
			return (await node.getNullifierMembershipWitness("latest", Fr.fromString(nullifier))) !== undefined
		},
		feeJuice: (address) => getFeeJuiceBalance(AztecAddress.fromStringUnsafe(address), node),
		sponsorFeeJuice: async () => getFeeJuiceBalance(await sponsoredFpcAddress(), node),
		async sponsorship(tx) {
			const fpc = await sponsoredFpcAddress()
			const leaf = await computeFeePayerBalanceLeafSlot(fpc)
			const slot = await computeFeePayerBalanceStorageSlot(fpc)
			const before = (await node.getPublicStorageAt(BlockNumber(tx.block - 1), ProtocolContractAddress.FeeJuice, slot)).toBigInt()
			const write = (await effectOf(tx.hash)).data.publicDataWrites.find((w) => w.leafSlot.equals(leaf))
			return { before, written: write?.value.toBigInt(), fee: tx.fee }
		},
	}
}
