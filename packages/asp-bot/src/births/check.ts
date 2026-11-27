import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { aspLeaf } from "@pp/bridge-spec"
import { birthId, birthLabel, siloedBirthNullifier } from "@pp/bridge-spec/birth"

export type BirthAnnouncement = { label: bigint; secret: bigint; owner: AztecAddress; amount: bigint }

export type ShieldDebited = { birthId: bigint; owner: AztecAddress; amount: bigint }

/**
 * The node's view of an announcement's transaction; `debits` holds only events the token emitted.
 * A transaction not yet in a block has `block` = Infinity.
 */
export type BirthTx = { success: boolean; block: number; nullifiers: bigint[]; debits: ShieldDebited[] }

export type Refusal = "above_pin" | "reverted" | "invalid_fields" | "label_mismatch" | "no_debit" | "no_nullifier"

export type Verdict = { ok: true; leaf: bigint } | { ok: false; reason: Refusal }

/** `tx` must be the announcement's own transaction: the announcement alone is the shielder's word. */
export async function checkBirth(token: AztecAddress, pin: number, a: BirthAnnouncement, tx: BirthTx): Promise<Verdict> {
	if (tx.block > pin) return { ok: false, reason: "above_pin" }
	if (!tx.success) return { ok: false, reason: "reverted" }
	let label: bigint
	try {
		label = birthLabel({ token, owner: a.owner, amount: a.amount, birthSecret: a.secret })
	} catch {
		// Its range errors can echo the amount; a verdict carries only a reason.
		return { ok: false, reason: "invalid_fields" }
	}
	if (label !== a.label) return { ok: false, reason: "label_mismatch" }
	const id = birthId({ label, birthSecret: a.secret })
	const debited = tx.debits.some((d) => d.birthId === id && d.owner.equals(a.owner) && d.amount === a.amount)
	if (!debited) return { ok: false, reason: "no_debit" }
	const nullifier = await siloedBirthNullifier({ token, owner: a.owner, birthSecret: a.secret })
	if (!tx.nullifiers.includes(nullifier)) return { ok: false, reason: "no_nullifier" }
	return { ok: true, leaf: aspLeaf(label) }
}
