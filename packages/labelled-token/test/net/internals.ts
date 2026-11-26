/**
 * The two wallet internals the suite reads: the proven tx a send hands its node, and the PXE's
 * handshake-secret import. Both are protected members of aztec.js's `BaseWallet`; the `Wallet`
 * interface offers neither.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { Tx } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"

type Internals = {
	aztecNode: { sendTx(tx: Tx): Promise<void> }
	pxe: { registerTaggingSecretSource(source: { kind: "handshake"; recipient: AztecAddress; ephPk: Fr }): Promise<void> }
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
