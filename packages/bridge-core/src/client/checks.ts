import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bridgeDataV1, claimSecretHash, deriveClaimSalt } from "@pp/bridge-spec"
import type { TransactProof } from "@pp/pool-client"
import { type Address, hexToBigInt, isAddressEqual } from "viem"
import { BridgeClientError, type SpendCheckName } from "./errors"
import type { SessionPool } from "./session"
import type { PreparedBridgeSpend } from "./types"

const fail = (check: SpendCheckName) => new BridgeClientError("SPEND_MISMATCH", { check })

const pair = <T>(p: readonly [T, T]) => Object.freeze([p[0], p[1]] as const)

function copyProof(p: TransactProof): TransactProof {
	return Object.freeze({
		pA: pair(p.pA),
		pB: Object.freeze([pair(p.pB[0]), pair(p.pB[1])] as const),
		pC: pair(p.pC),
		pubSignals: Object.freeze(p.pubSignals.map((row) => Object.freeze([...row]))),
	})
}

/**
 * A deep, frozen copy of everything `submit` checks and sends, taken before its first await. viem
 * hands a simulation's `args` back by reference, so without it a caller mutating its arrays across
 * an await could change what is sent after it was checked.
 * @throws BridgeClientError `SPEND_MISMATCH` with check `shape` for a value that is not a spend
 */
export function snapshotSpend(s: PreparedBridgeSpend): PreparedBridgeSpend {
	try {
		return Object.freeze({
			proof: copyProof(s.proof),
			noteData: Object.freeze(s.noteData.map((n) => Object.freeze({ hint: n.hint, data: n.data }))),
			processor: s.processor,
			data: s.data,
			nullifier: s.nullifier,
			spentCommitment: s.spentCommitment,
			change: Object.freeze({ ...s.change }),
			amount: s.amount,
			asset: s.asset,
			aspRoot: s.aspRoot,
			secretHash: s.secretHash,
			claimSalt: s.claimSalt,
			recipient: AztecAddress.fromStringUnsafe(s.recipient.toString()),
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
