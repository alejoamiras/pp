import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { claimSecretHash, deriveClaimSalt } from "@pp/bridge-spec"
import { latestMined, observe, pendingStep } from "./attempts"
import { guarded } from "./boundary"
import { type ClaimNode, claimState } from "./claim"
import { Journal, type JournalRecord, type KeyValueStore } from "./journal"
import { bridgeMessageKey } from "./messages"
import { bridgedReceipts, type ResolverClient, type ResolverDeployment, resolveNullifier } from "./resolve"
import { type SessionPool, type SessionSecrets, useSession } from "./session"
import type { BridgeReceipt, BridgeRecordView, BridgeStep } from "./types"

export type RecordsContext = {
	deployment: ResolverDeployment & { id: string; hub: string }
	reader: ResolverClient
	node: ClaimNode
	store: KeyValueStore
}

type Ctx = RecordsContext & { journal: Journal; secrets: SessionSecrets }

const lastHash = (r: JournalRecord) => {
	const hash = r.attempts.findLast((a) => a.l1TxHash)?.l1TxHash
	return hash ? { l1TxHash: hash } : {}
}

const STEP_OF_CLAIM = { found: "claimable", missing: "mined", nullified: "claimed" } as const

/** The record's step read from the chain now; a claimed record is reported once, then deleted. */
async function viewOf(c: Ctx, record: JournalRecord, spentCommitment: bigint): Promise<BridgeRecordView> {
	const claimSalt = deriveClaimSalt(c.secrets.claimKey, spentCommitment)
	const secretHash = await claimSecretHash(claimSalt, AztecAddress.fromStringUnsafe(record.recipient))
	const observed = await Promise.all(record.attempts.map((a) => observe(c.reader, a)))
	const mined = latestMined(observed)
	const intent = { nullifier: record.nullifier, amount: record.amount, secretHash }
	const r = await resolveNullifier(c.reader, c.deployment, intent, mined !== undefined, mined?.block)
	const base = {
		id: await c.journal.id(record.nullifier),
		nullifier: record.nullifier,
		recipient: record.recipient,
		amount: record.amount,
	}
	if (r.kind !== "bridged") {
		const step: BridgeStep =
			r.kind === "open"
				? pendingStep(
						record,
						observed.map((o) => o.state),
					)
				: { error: r.kind === "elsewhere" ? "CONSUMED_ELSEWHERE" : "RPC_INCONSISTENT" }
		return { ...base, ...lastHash(record), step }
	}
	const state = await claimState(c.node, c.deployment.hub, r.receipt, claimSalt, record.recipient)
	if (state === "nullified") await c.journal.remove(record.nullifier)
	return { ...base, l1TxHash: r.receipt.l1TxHash, step: STEP_OF_CLAIM[state], receipt: r.receipt }
}

/**
 * The session's journal records, pending ones included, each with its step derived from the chain:
 * `submitted`, `mined`, `claimable`, `claimed` (reported once, then the record is deleted), or an
 * error. A reload reads these before offering a bridge, so it never offers a second bridge of a note
 * already sent. A record that no longer opens is skipped and kept.
 */
export function records(ctx: RecordsContext, s: unknown): Promise<BridgeRecordView[]> {
	return guarded(async () => {
		const { session, secrets } = useSession(s, ctx.deployment.id)
		const c: Ctx = { ...ctx, secrets, journal: new Journal(ctx.store, secrets.journal, ctx.deployment.id) }
		const views: BridgeRecordView[] = []
		for (const note of await session.pool.notes()) {
			const { record } = await c.journal.read(await session.pool.nullifierOf(note.commitment))
			if (record) views.push(await viewOf(c, record, note.commitment))
		}
		return views
	})
}

/** Whether `r` is `who`'s bridge of the note with `commitment`, and not yet claimed. */
async function unclaimedFor(ctx: RecordsContext, claimKey: Uint8Array, who: AztecAddress, r: BridgeReceipt, commitment: bigint) {
	const claimSalt = deriveClaimSalt(claimKey, commitment)
	const expected = await bridgeMessageKey(ctx.deployment, r, await claimSecretHash(claimSalt, who))
	if (expected.toLowerCase() !== r.messageKey.toLowerCase()) return false
	return (await claimState(ctx.node, ctx.deployment.hub, r, claimSalt, who.toString())) !== "nullified"
}

/** The session's spent notes, by nullifier. */
async function spentNotes(pool: SessionPool): Promise<Map<bigint, bigint>> {
	const spent = new Map<bigint, bigint>()
	for (const n of await pool.notes()) if (n.status === "spent") spent.set(await pool.nullifierOf(n.commitment), n.commitment)
	return spent
}

/**
 * `recipient`'s unclaimed bridges of the session's spent notes, from chain data and the signature
 * alone: each portal event whose message, under the session's salt for that note and `recipient`,
 * is the event's own. Ids equal `records()`'s for the same nullifier.
 */
export function recover(ctx: RecordsContext, s: unknown, recipient: AztecAddress): Promise<(BridgeReceipt & { id: string })[]> {
	return guarded(async () => {
		const { session, secrets } = useSession(s, ctx.deployment.id)
		const who = AztecAddress.fromStringUnsafe(String(recipient.toString()))
		const journal = new Journal(ctx.store, secrets.journal, ctx.deployment.id)
		const spent = await spentNotes(session.pool)
		const found: (BridgeReceipt & { id: string })[] = []
		for (const r of await bridgedReceipts(ctx.reader, ctx.deployment, [...spent.keys()])) {
			const commitment = spent.get(r.nullifier)
			if (commitment !== undefined && (await unclaimedFor(ctx, secrets.claimKey, who, r, commitment)))
				found.push({ ...r, id: await journal.id(r.nullifier) })
		}
		return found
	})
}
