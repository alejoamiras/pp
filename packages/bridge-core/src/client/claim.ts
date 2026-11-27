import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { lookUpL1ToL2MessageWitness } from "@aztec-labs/stdlib/messaging"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { changeCommitment, deriveClaimSalt } from "@pp/bridge-spec"
import { tokenBridgeHubArtifact } from "../artifacts"
import { l1ToL2MessageReadiness, type MessageReadinessNode } from "../l1-to-l2-readiness"
import { guarded } from "./boundary"
import { BridgeClientError } from "./errors"
import { claimNullifier } from "./messages"
import { callPayload, sponsored } from "./payload"
import { type SessionPool, useSession } from "./session"
import type { BridgeReceipt } from "./types"

export type ClaimDeployment = { id: string; hub: string; token: string }

export type ClaimNode = MessageReadinessNode & Pick<AztecNode, "getL1ToL2MessageMembershipWitness" | "findLeavesIndexes">

/** Whether a bridge's message is on the tree unconsumed, not there yet, or consumed by its claim. */
export type ClaimState = "found" | "missing" | "nullified"

export type WaitClaimableOptions = { forceBlock?: () => Promise<void>; signal?: AbortSignal }

const POLL_MS = 1_500

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = () => {
			clearTimeout(timer)
			reject(signal?.reason)
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", done)
			resolve()
		}, ms)
		signal?.addEventListener("abort", done, { once: true })
	})
}

/**
 * Resolves once the bridge's message can be consumed: the latest block's message tree has passed
 * its leaf. `forceBlock` is for bare harnesses whose chain has no heartbeat.
 * @throws the signal's reason, translated at the boundary, once `o.signal` aborts
 */
export function waitClaimable(node: MessageReadinessNode, r: BridgeReceipt, o: WaitClaimableOptions = {}): Promise<void> {
	return guarded(async () => {
		const { messageKey } = r
		for (;;) {
			o.signal?.throwIfAborted()
			const ready = await l1ToL2MessageReadiness(node, messageKey)
			if (ready && ready.anchor >= ready.checkpoint) return
			if (o.forceBlock) await o.forceBlock()
			await delay(POLL_MS, o.signal)
		}
	})
}

/**
 * The message's state for `recipient`'s claim, read against the hub-siloed consumption nullifier
 * (`claimNullifier`). No balance fallback: a claimed note later spent would read as unclaimed.
 */
export async function claimState(
	node: ClaimNode,
	hub: string,
	r: Pick<BridgeReceipt, "messageKey">,
	claimSalt: bigint,
	recipient: string,
): Promise<ClaimState> {
	const consumed = await claimNullifier(hub, r.messageKey, claimSalt, recipient)
	return (await lookUpL1ToL2MessageWitness(node as AztecNode, Fr.fromString(r.messageKey), consumed, "latest")).type
}

/** The commitment of the owned note whose nullifier is `nullifier`. */
async function spentCommitmentOf(pool: SessionPool, nullifier: bigint): Promise<bigint> {
	for (const n of await pool.notes()) if ((await pool.nullifierOf(n.commitment)) === nullifier) return n.commitment
	throw new BridgeClientError("NOTE_NOT_FOUND")
}

/**
 * The hub call that claims `r` to the account that sends it, paid by the SponsoredFPC. The claim
 * salt derives inside the session from the spent note and the change opening comes from the pool,
 * so it works after a reload and from a fresh device. The payload carries the salt: never log it.
 * @throws BridgeClientError `NOTE_NOT_FOUND` when no owned note has `r.nullifier`; `OPENING_MISMATCH`
 *   when the pool's change opening does not commit to `r.changeCommitment`
 */
export function claimPayload(d: ClaimDeployment, s: unknown, r: BridgeReceipt): Promise<ExecutionPayload> {
	return guarded(async () => {
		const { session, secrets } = useSession(s, d.id)
		const { nullifier, amount, leafIndex, changeCommitment: committed } = r
		const spent = await spentCommitmentOf(session.pool, nullifier)
		const opening = await session.pool.changeOpening(nullifier)
		if (changeCommitment(opening.precommitment, opening.label) !== committed) throw new BridgeClientError("OPENING_MISMATCH")
		const claimSalt = deriveClaimSalt(secrets.claimKey, spent)
		const args = [AztecAddress.fromStringUnsafe(d.token), amount, nullifier, opening.precommitment, opening.label, claimSalt, leafIndex]
		return sponsored(await callPayload(tokenBridgeHubArtifact, AztecAddress.fromStringUnsafe(d.hub), "claim_from_pool", args))
	})
}
