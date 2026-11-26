/**
 * Hashes of a label born on Aztec by a shield, mirrored by Noir `pp_hash::birth`. The bot recomputes
 * them to approve a birth, so a drift leaves valid births pending. Importing this module initialises
 * Barretenberg; the package root never imports it.
 */
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import { assertField, assertRange, U128_MAX } from "./fields"

/** Frozen `u32` separators ("pbl1", "pbn1", "pbi1"). */
export const DOM_SEP__PP_BIRTH_LABEL = 0x70626c31
export const DOM_SEP__PP_BIRTH_NULLIFIER = 0x70626e31
export const DOM_SEP__PP_BIRTH_ID = 0x70626931

// Checked before any Fr is built: Fr's constructor echoes a rejected value, and the birth secret is secret.
const secretFr = (birthSecret: bigint) => new Fr(assertField(birthSecret, "birthSecret", true))

/** `label′ = poseidon2_hash_with_separator([token, owner, amount, birth_secret], DOM_SEP__PP_BIRTH_LABEL)`. */
export function birthLabel(a: { token: AztecAddress; owner: AztecAddress; amount: bigint; birthSecret: bigint }): bigint {
	const amount = new Fr(assertRange(a.amount, 0n, U128_MAX, "AmountOutOfRange", "amount"))
	return poseidon2HashWithSeparator([a.token, a.owner, amount, secretFr(a.birthSecret)], DOM_SEP__PP_BIRTH_LABEL).toBigInt()
}

/** The inner birth nullifier the token pushes; the protocol silos it by the token's address. */
export function birthNullifier(a: { owner: AztecAddress; birthSecret: bigint }): bigint {
	return poseidon2HashWithSeparator([a.owner, secretFr(a.birthSecret)], DOM_SEP__PP_BIRTH_NULLIFIER).toBigInt()
}

/** The siloed birth nullifier: the value that appears on chain and that the bot looks for. */
export async function siloedBirthNullifier(a: { token: AztecAddress; owner: AztecAddress; birthSecret: bigint }): Promise<bigint> {
	return (await siloNullifier(a.token, new Fr(birthNullifier(a)))).toBigInt()
}

/** `birth_id = poseidon2_hash_with_separator([label′, birth_secret], DOM_SEP__PP_BIRTH_ID)`, emitted by the shield's public debit. */
export function birthId(a: { label: bigint; birthSecret: bigint }): bigint {
	return poseidon2HashWithSeparator([new Fr(assertField(a.label, "label")), secretFr(a.birthSecret)], DOM_SEP__PP_BIRTH_ID).toBigInt()
}
