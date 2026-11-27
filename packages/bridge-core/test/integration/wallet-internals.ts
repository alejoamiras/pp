/**
 * What the hub and stack suites need beyond the `Wallet` interface: the proven transaction a send hands
 * its node, proving without sending, and a fee payment that runs a call in the setup phase. The first
 * two use protected members of aztec.js's `BaseWallet`: re-check them on every `@aztec-labs` bump.
 * `@pp/labelled-token`'s network suite keeps its own copy; importing it here would be a dependency cycle.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { mergeExecutionPayloads, type Tx, type TxReceipt } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { TxExecutionRequest, TxProvingResult } from "@aztec-labs/stdlib/tx"
import type { L2Base } from "../../scripts/sandbox/l2"

type Internals = {
	aztecNode: { sendTx(tx: Tx): Promise<void> }
	pxe: {
		sync(): Promise<void>
		proveTx(req: TxExecutionRequest, opts: { scopes: AztecAddress[]; senderForTags?: AztecAddress }): Promise<TxProvingResult>
	}
	completeFeeOptions(config: { from: AztecAddress; feePayer?: AztecAddress; gasSettings?: unknown }): Promise<unknown>
	createTxExecutionRequestFromPayloadAndFee(payload: unknown, from: AztecAddress, fee: unknown): Promise<TxExecutionRequest>
}

const internals = (wallet: unknown): Internals => wallet as Internals

/** Records every transaction `wallet` sends from now on, exactly as proven. */
export function captureSentTxs(wallet: unknown): Tx[] {
	const node = internals(wallet).aztecNode
	const send = node.sendTx.bind(node)
	const sent: Tx[] = []
	node.sendTx = (tx) => {
		sent.push(tx)
		return send(tx)
	}
	return sent
}

export interface Proven {
	tx: Tx
	anchorTimestamp: bigint
	expirationTimestamp: bigint
}

/** The sender a proof is made for: its wallet, its account, and the fee options its sends use. */
export interface Prover {
	wallet: Wallet
	from: AztecAddress
	fee: { gasSettings?: unknown }
}

/** Proves `call` as `p` would send it, fee included, without sending it, so the chain can move before the same bytes land. */
export async function prove(p: Prover, call: ContractFunctionInteraction): Promise<Proven> {
	const w = internals(p.wallet)
	await w.pxe.sync()
	const payload = (await call.request({ fee: p.fee } as never)) as { feePayer?: AztecAddress }
	const fee = await w.completeFeeOptions({ from: p.from, feePayer: payload.feePayer, gasSettings: p.fee.gasSettings })
	const req = await w.createTxExecutionRequestFromPayloadAndFee(payload, p.from, fee)
	const proven = await w.pxe.proveTx(req, { scopes: [p.from], senderForTags: p.from })
	return {
		tx: await proven.toTx(),
		anchorTimestamp: proven.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
		expirationTimestamp: proven.publicInputs.expirationTimestamp,
	}
}

/** Sends a proven transaction and waits for it to be mined, reverted or not. */
export async function land(node: L2Base["node"], proven: Proven): Promise<TxReceipt> {
	await node.sendTx(proven.tx)
	return waitForTx(node, proven.tx.getTxHash(), { dontThrowOnRevert: true })
}

/** `sponsor` with `call` run ahead of it, before the sponsor ends the setup phase. */
export function runInSetup(sponsor: FeePaymentMethod, call: { request(): Promise<unknown> }): FeePaymentMethod {
	return {
		getAsset: () => sponsor.getAsset(),
		getFeePayer: () => sponsor.getFeePayer(),
		getGasSettings: () => sponsor.getGasSettings(),
		getExecutionPayload: async () => mergeExecutionPayloads([(await call.request()) as never, await sponsor.getExecutionPayload()]),
	}
}
