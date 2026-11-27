/**
 * The wallet internals the suite reads: the proven tx a send hands its node, proving without
 * sending, and the PXE's handshake-secret import. All are protected members of aztec.js's
 * `BaseWallet`, which the `Wallet` interface does not offer: re-check them on every `@aztec-labs` bump.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import type { Tx, TxReceipt } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { L2Base } from "@pp/bridge-core/sandbox"
import type { TxExecutionRequest, TxProvingResult } from "@aztec-labs/stdlib/tx"
import type { Device } from "./token"

type Internals = {
	aztecNode: { sendTx(tx: Tx): Promise<void> }
	pxe: {
		registerTaggingSecretSource(source: { kind: "handshake"; recipient: AztecAddress; ephPk: Fr }): Promise<void>
		sync(): Promise<void>
		proveTx(req: TxExecutionRequest, opts: { scopes: AztecAddress[]; senderForTags?: AztecAddress }): Promise<TxProvingResult>
	}
	completeFeeOptions(config: { from: AztecAddress; feePayer?: AztecAddress; gasSettings?: unknown }): Promise<unknown>
	createTxExecutionRequestFromPayloadAndFee(payload: unknown, from: AztecAddress, fee: unknown): Promise<TxExecutionRequest>
}

const internals = (wallet: Wallet): Internals => wallet as unknown as Internals

/** Records every tx `wallet` sends from now on, exactly as proven. */
export function captureSentTxs(wallet: Wallet): Tx[] {
	const node = internals(wallet).aztecNode
	const send = node.sendTx.bind(node)
	const sent: Tx[] = []
	node.sendTx = (tx) => {
		sent.push(tx)
		return send(tx)
	}
	return sent
}

/** Imports an interactive handshake the account signed, from the `eph_pk.x` the wallet kept. */
export function importHandshake(wallet: Wallet, recipient: AztecAddress, ephX: Fr): Promise<void> {
	return internals(wallet).pxe.registerTaggingSecretSource({ kind: "handshake", recipient, ephPk: ephX })
}

export interface Proven {
	tx: Tx
	anchorTimestamp: bigint
	expirationTimestamp: bigint
	/** Wall-clock of the PXE's `proveTx` alone: witness generation and, on a proving wallet, the proof. */
	provingMs: number
}

/** Proves `call` as `d` sends it, fee included, without sending it, so the chain can move before the same bytes land. */
export async function prove(d: Device, call: ContractFunctionInteraction): Promise<Proven> {
	const w = internals(d.wallet)
	await w.pxe.sync()
	const payload = (await call.request({ fee: d.fee } as never)) as { feePayer?: AztecAddress }
	const fee = await w.completeFeeOptions({ from: d.from, feePayer: payload.feePayer, gasSettings: d.fee.gasSettings })
	const req = await w.createTxExecutionRequestFromPayloadAndFee(payload, d.from, fee)
	const start = performance.now()
	const proven = await w.pxe.proveTx(req, { scopes: [d.from], senderForTags: d.from })
	const provingMs = performance.now() - start
	return {
		tx: await proven.toTx(),
		anchorTimestamp: proven.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
		expirationTimestamp: proven.publicInputs.expirationTimestamp,
		provingMs,
	}
}

/** Sends a proven tx and waits for it to be mined, reverted or not. */
export async function land(node: L2Base["node"], proven: Proven): Promise<TxReceipt> {
	await node.sendTx(proven.tx)
	return waitForTx(node, proven.tx.getTxHash(), { dontThrowOnRevert: true })
}
