import { sha256 } from "@noble/hashes/sha2"
import type { Address, Hex } from "viem"
import { assertField, assertRange, BN254_P, bytesToBigInt, concat, hexBytes, SpecRangeError, toHex, U128_MAX, word } from "./fields"
import { tagValue } from "./tags"

/** Aztec's `sha256ToField`: the first 31 bytes of the digest as a field (`uint256(sha256(x)) >> 8`). */
export function sha256ToField(bytes: Uint8Array): bigint {
	return bytesToBigInt(sha256(bytes).subarray(0, 31))
}

const amountWord = (amount: bigint) => word(assertRange(amount, 1n, U128_MAX, "AmountOutOfRange", "amount"))

/** A payee that is not exactly 20 bytes is `PayeeOutOfRange`, as a Noir payee word ≥ 2^160 is. */
function payeeWord(payee: Address): Uint8Array {
	const bytes = hexBytes(payee, 20)
	if (bytes === undefined) throw new SpecRangeError("PayeeOutOfRange", "payee", String(payee))
	const v = bytesToBigInt(bytes)
	if (v === 0n) throw new SpecRangeError("ZeroPayee", "payee")
	return word(v)
}

/** `TransactParams.data`: `abi.encode(PP_BRIDGE_DATA_V1, secretHash)`, 64 bytes. */
export function bridgeDataV1(secretHash: Hex): Hex {
	const bytes = hexBytes(secretHash, 32)
	if (bytes === undefined) throw new SpecRangeError("SecretHashOutOfRange", "secretHash", String(secretHash))
	assertRange(bytesToBigInt(bytes), 1n, BN254_P - 1n, "SecretHashOutOfRange", "secretHash")
	return toHex(concat([word(tagValue("DATA_V1")), bytes]))
}

export type BridgeContent = { nullifier: bigint; changeCommitment: bigint; amount: bigint }
export type ExitContent = { payee: Address; amount: bigint }
export type RagequitContent = { payee: Address; amount: bigint; label: bigint }

export function bridgeContentPreimageV1(a: BridgeContent): Uint8Array {
	return concat([
		word(tagValue("IN_V1")),
		word(assertField(a.nullifier, "nullifier")),
		word(assertField(a.changeCommitment, "changeCommitment")),
		amountWord(a.amount),
	])
}

export function exitContentPreimageV1(a: ExitContent): Uint8Array {
	return concat([word(tagValue("OUT_V1")), payeeWord(a.payee), amountWord(a.amount)])
}

export function ragequitContentPreimageV1(a: RagequitContent): Uint8Array {
	return concat([
		word(tagValue("RAGEQUIT_V1")),
		payeeWord(a.payee),
		amountWord(a.amount),
		word(assertRange(a.label, 1n, BN254_P - 1n, "LabelOutOfRange", "label")),
	])
}

/** Inbox content of a bridge: `H(IN_V1, nullifier, changeCommitment, amount)`. */
export const bridgeContentV1 = (a: BridgeContent): bigint => sha256ToField(bridgeContentPreimageV1(a))

/** Outbox content of a screened public exit: `H(OUT_V1, payee, amount)`. */
export const exitContentV1 = (a: ExitContent): bigint => sha256ToField(exitContentPreimageV1(a))

/** Outbox content of a ragequit: `H(RAGEQUIT_V1, payee, amount, label)`. */
export const ragequitContentV1 = (a: RagequitContent): bigint => sha256ToField(ragequitContentPreimageV1(a))
