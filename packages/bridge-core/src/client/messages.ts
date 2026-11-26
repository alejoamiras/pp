import { DomainSeparator } from "@aztec-labs/constants"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import { L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging"
import { bridgeContentV1, exitContentV1, ragequitContentV1 } from "@pp/bridge-spec"
import { deriveTokenClaimSecret } from "@pp/bridge-spec/claim-secret"
import type { Address, Hex } from "viem"
import type { ExitTicket } from "./types"

/** The fields of one `BridgedFromPool` event the message hash depends on. */
export type BridgedEvent = { nullifier: bigint; changeCommitment: bigint; amount: bigint; leafIndex: bigint }

export type MessageEndpoints = { portal: Address; chainId: number; hub: string; rollupVersion: bigint }

/**
 * The Inbox message key a bridge with this secret hash produced, through the SDK's own
 * `L1ToL2Message.hash()` so there is one implementation of the Inbox encoding. Equal to the
 * event's `messageKey` exactly when the bridge pays the intended recipient.
 */
export async function bridgeMessageKey(m: MessageEndpoints, e: BridgedEvent, secretHash: bigint): Promise<Hex> {
	const content = bridgeContentV1({ nullifier: e.nullifier, changeCommitment: e.changeCommitment, amount: e.amount })
	const message = new L1ToL2Message(
		new L1Actor(EthAddress.fromString(m.portal), m.chainId),
		new L2Actor(AztecAddress.fromStringUnsafe(m.hub), Number(m.rollupVersion)),
		new Fr(content),
		new Fr(secretHash),
		new Fr(e.leafIndex),
	)
	return message.hash().toString() as Hex
}

/**
 * The nullifier the hub emits when it consumes this message, unsiloed, with the hub to silo it:
 * the hub consumes with the one-field secret `[derive_claim_secret(claim_salt, recipient)]`, and
 * the protocol nullifies a message as `poseidon2([messageHash, secret], MESSAGE_NULLIFIER)`.
 */
export async function claimNullifier(
	hub: string,
	messageKey: Hex,
	claimSalt: bigint,
	recipient: string,
): Promise<{ contractAddress: AztecAddress; nullifier: Fr }> {
	const secret = deriveTokenClaimSecret(new Fr(claimSalt), AztecAddress.fromStringUnsafe(recipient))
	const nullifier = await poseidon2HashWithSeparator([Fr.fromString(messageKey), secret], DomainSeparator.MESSAGE_NULLIFIER)
	return { contractAddress: AztecAddress.fromStringUnsafe(hub), nullifier }
}

/** The Outbox message an exit ticket's burn sent to the portal, through the SDK's own hash. */
export function exitMessageHash(m: MessageEndpoints, t: ExitTicket): Hex {
	const content =
		t.kind === "ragequit"
			? ragequitContentV1({ payee: t.payee, amount: t.amount, label: t.label })
			: exitContentV1({ payee: t.payee, amount: t.amount })
	return computeL2ToL1MessageHash({
		l2Sender: AztecAddress.fromStringUnsafe(m.hub),
		l1Recipient: EthAddress.fromString(m.portal),
		content: new Fr(content),
		rollupVersion: new Fr(m.rollupVersion),
		chainId: new Fr(BigInt(m.chainId)),
	}).toString() as Hex
}
