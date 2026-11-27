import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bridgeDataV1, claimSecretHash, deriveClaimSalt } from "@pp/bridge-spec"
import type { TransactProof } from "@pp/pool-client"
import { type Address, hexToBigInt, isAddressEqual } from "viem"
import { BridgeClientError, type SpendCheckName } from "./errors"
import type { SessionPool } from "./session"
import type { PreparedBridgeSpend } from "./types"

const fail = (check: SpendCheckName) => new BridgeClientError("SPEND_MISMATCH", { check })

// Each value is read once and must already be a primitive of its type, so neither an accessor nor a
// caller's own `map` or iterator can make the checked copy differ from the one sent.
const HEX = /^0x[0-9a-fA-F]*$/

function big(v: unknown): bigint {
	if (typeof v !== "bigint") throw fail("shape")
	return v
}

function hex(v: unknown): `0x${string}` {
	if (typeof v !== "string" || !HEX.test(v)) throw fail("shape")
	return v as `0x${string}`
}

function list<T>(v: unknown, item: (x: unknown) => T, length?: number): readonly T[] {
	if (!Array.isArray(v) || (length !== undefined && v.length !== length)) throw fail("shape")
	const n = v.length
	const out: T[] = []
	for (let i = 0; i < n; i++) out.push(item(v[i]))
	return Object.freeze(out)
}

const pair = (v: unknown) => list(v, big, 2) as readonly [bigint, bigint]

function copyProof(p: TransactProof): TransactProof {
	const { pA, pB, pC, pubSignals } = p
	return Object.freeze({
		pA: pair(pA),
		pB: list(pB, pair, 2) as readonly [readonly [bigint, bigint], readonly [bigint, bigint]],
		pC: pair(pC),
		pubSignals: list(pubSignals, (row) => list(row, big)),
	})
}

function copyNote(n: unknown) {
	if (typeof n !== "object" || n === null) throw fail("shape")
	const { hint, data } = n as Record<string, unknown>
	return Object.freeze({ hint: hex(hint), data: hex(data) })
}

function copyChange(c: PreparedBridgeSpend["change"]) {
	const { commitment, precommitment, label, value } = c
	return Object.freeze({ commitment: big(commitment), precommitment: big(precommitment), label: big(label), value: big(value) })
}

/**
 * A deep, frozen copy of everything `submit` checks and sends, taken before its first await. viem
 * hands a simulation's `args` back by reference, so without it a caller mutating its arrays across
 * an await could change what is sent after it was checked.
 * @throws BridgeClientError `SPEND_MISMATCH` with check `shape` for a value that is not a spend
 */
export function snapshotSpend(s: PreparedBridgeSpend): PreparedBridgeSpend {
	try {
		const { processor, data, nullifier, spentCommitment, amount, asset, aspRoot, secretHash, claimSalt, recipient } = s
		return Object.freeze({
			proof: copyProof(s.proof),
			noteData: list(s.noteData, copyNote),
			processor: hex(processor),
			data: hex(data),
			nullifier: big(nullifier),
			spentCommitment: big(spentCommitment),
			change: copyChange(s.change),
			amount: big(amount),
			asset: hex(asset),
			aspRoot: big(aspRoot),
			secretHash: hex(secretHash),
			claimSalt: big(claimSalt),
			recipient: AztecAddress.fromStringUnsafe(String(recipient.toString())),
		})
	} catch {
		throw fail("shape")
	}
}

const WORD = /^0x[0-9a-fA-F]{64}$/

/**
 * Every precondition of an irreversible spend, against the proof rather than metadata: pool-client's
 * checks (request, params, public signals, the nullifier, the change opening, the context), then the
 * bridge's own, each failure naming its check. A matching but non-canonical salt is refused.
 * @param s a snapshot from `snapshotSpend`
 * @throws BridgeClientError `SPEND_MISMATCH`; pool-client's own failures throw `PoolClientError`
 */
export async function assertBridgeSpend(
	s: PreparedBridgeSpend,
	pool: SessionPool,
	claimKey: Uint8Array,
	target: { portal: Address; asset: Address },
): Promise<void> {
	await pool.assertRecoverable(s)
	if (deriveClaimSalt(claimKey, s.spentCommitment) !== s.claimSalt) throw fail("salt")
	if (!WORD.test(s.secretHash) || (await claimSecretHash(s.claimSalt, s.recipient)) !== hexToBigInt(s.secretHash))
		throw fail("secretHash")
	if (bridgeDataV1(s.secretHash).toLowerCase() !== s.data.toLowerCase()) throw fail("data")
	if (!isAddressEqual(s.processor, target.portal)) throw fail("processor")
	if (s.proof.pubSignals[6]?.[0] !== hexToBigInt(target.asset)) throw fail("asset")
	if (!(await s.recipient.isValid())) throw fail("recipient")
}
