import { BaseError, type Hash, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem"
import type { JournalAttempt, JournalRecord } from "./journal"
import type { ResolverClient } from "./resolve"
import type { BridgeStep } from "./types"

/** What the chain says about one attempt, once the resolver has found no event for the nullifier. */
export type AttemptState = "pending" | "reverted" | "unknown" | "hashless"

export const MAX_UNRESOLVED_ATTEMPTS = 4

export type Intent = { nullifier: bigint; recipient: string; amount: bigint }

export type AttemptPlan = { kind: "send"; record: JournalRecord } | { kind: "refuse"; code: "IN_FLIGHT" | "UNCERTAIN"; hashes: Hash[] }

const sameIntent = (r: JournalRecord, i: Intent) => r.recipient.toLowerCase() === i.recipient.toLowerCase() && r.amount === i.amount

/**
 * Decides whether a new send may go out, given the record and each attempt's state (same order).
 * A plain call never sends while an earlier send may still land; `acceptUncertain` admits one more
 * attempt for the same intent, evicting the oldest unresolved one when four are held and marking the
 * record `evicted` for good, because the forgotten hash may still land. Confirmed reverts are pruned
 * first, so known failures never count toward the cap and no sequence of attempts locks the note.
 *
 * @returns the record to write before the wallet call (its last attempt hashless), or the refusal
 */
export function planAttempt(
	record: JournalRecord | null,
	states: readonly AttemptState[],
	intent: Intent,
	acceptUncertain: boolean,
): AttemptPlan {
	if (record === null) return { kind: "send", record: { ...intent, attempts: [{}] } }
	if (states.length !== record.attempts.length) throw new Error("one state per attempt")

	const open = record.attempts.filter((_, i) => states[i] !== "reverted")
	const openStates = states.filter((s) => s !== "reverted")
	const hashes = open.flatMap((a) => (a.l1TxHash ? [a.l1TxHash] : []))

	if (openStates.includes("pending")) return { kind: "refuse", code: "IN_FLIGHT", hashes }
	const uncertain = open.length > 0 || record.evicted === true
	if (!uncertain) return { kind: "send", record: { ...intent, attempts: [{}] } }
	if (!acceptUncertain || !sameIntent(record, intent)) return { kind: "refuse", code: "UNCERTAIN", hashes }

	const evict = open.length >= MAX_UNRESOLVED_ATTEMPTS
	const kept = evict ? open.slice(open.length - MAX_UNRESOLVED_ATTEMPTS + 1) : open
	return {
		kind: "send",
		record: {
			nullifier: record.nullifier,
			recipient: record.recipient,
			amount: record.amount,
			attempts: [...kept, {}],
			...(evict || record.evicted ? { evicted: true as const } : {}),
		},
	}
}

/** The step a record shows while the resolver finds no event for its nullifier. */
export function pendingStep(record: JournalRecord, states: readonly AttemptState[]): BridgeStep {
	if (record.evicted || states.some((s) => s !== "reverted")) return "submitted"
	return record.attempts.length === 0 ? "prepared" : { error: "REVERTED" }
}

const isNotFound = (e: unknown) =>
	e instanceof BaseError && e.walk((x) => x instanceof TransactionReceiptNotFoundError || x instanceof TransactionNotFoundError) !== null

const orNull = (e: unknown): null => {
	if (isNotFound(e)) return null
	throw e
}

export type Observed = { state: AttemptState; mined?: { hash: Hash; block: bigint } }

/** What the RPC says about one attempt; a successful receipt sets the resolver's precedence and lower bound on the head. */
export async function observe(c: Pick<ResolverClient, "getTransactionReceipt" | "getTransaction">, a: JournalAttempt): Promise<Observed> {
	if (!a.l1TxHash) return { state: "hashless" }
	const receipt = await c.getTransactionReceipt({ hash: a.l1TxHash }).catch(orNull)
	if (receipt?.status === "success") return { state: "pending", mined: { hash: a.l1TxHash, block: receipt.blockNumber } }
	if (receipt) return { state: "reverted" }
	const tx = await c.getTransaction({ hash: a.l1TxHash }).catch(orNull)
	return { state: tx ? "pending" : "unknown" }
}

/** The latest successful attempt, which the resolver must read up to and an error must name. */
export const latestMined = (o: readonly Observed[]) =>
	o.reduce<Observed["mined"]>((m, x) => (x.mined && (!m || x.mined.block >= m.block) ? x.mined : m), undefined)
