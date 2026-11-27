import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { PreparedSpend } from "@pp/pool-client"
import type { Address, Hash, Hex } from "viem"

/**
 * A pool spend to the portal plus what its message binds. `claimSalt` and `secretHash` derive from
 * the session's claim key and the spent commitment, so a re-proof keeps both and the journal record.
 */
export type PreparedBridgeSpend = PreparedSpend & { secretHash: Hex; claimSalt: bigint; recipient: AztecAddress }

export type BridgeStep = "prepared" | "submitted" | "mined" | "claimable" | "claiming" | "claimed" | { error: string }

/** Built only from a verified `BridgedFromPool` event, never from the sender's own receipt. */
export type BridgeReceipt = {
	l1TxHash: Hash
	portal: Address
	messageKey: Hex
	leafIndex: bigint
	nullifier: bigint
	changeCommitment: bigint
	amount: bigint
	asset: Address
}

export type BridgeRecordView = {
	/** Equal to the id `recover` gives the same nullifier. */
	id: string
	nullifier: bigint
	recipient: AztecAddress
	amount: bigint
	l1TxHash?: Hash
	step: BridgeStep
	receipt?: BridgeReceipt
}

export type ExitTicket =
	| {
			kind: "ragequit"
			token: string
			payee: Address
			amount: bigint
			label: bigint
			l2TxHash: Hex
			messageIndexInTx: number
	  }
	| { kind: "public"; token: string; payee: Address; amount: bigint; l2TxHash: Hex; messageIndexInTx: number }

export type ExitStatus = "proving" | "ready" | "settled"

/** The addresses one bridge generation lives at; `id` keys sessions and journal records to it. */
export type BridgeDeployment = {
	chainId: number
	portal: Address
	hub: string
	token: string
	asset: Address
	poolVault: Address
	deployBlock: bigint
	rollupVersion: bigint
}

export const deploymentId = (d: Pick<BridgeDeployment, "chainId" | "portal" | "hub">): string =>
	`${d.chainId}:${d.portal.toLowerCase()}:${d.hub.toLowerCase()}`
