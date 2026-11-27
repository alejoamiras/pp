import { type Address, encodeFunctionData, type Hex, isAddressEqual, toHex } from "viem"
import { KEYSTORE_REGISTRATION_ABI, POOL_VAULT_VIEWS_ABI } from "./abi.ts"
import { PoolClientError } from "./errors.ts"
import type { RootReader } from "./fresh.ts"
import type { Keys } from "./keys.ts"
import type { NoteComputationService, PoseidonHashService } from "./sdk.ts"
import type { PoolConfig, RegistrationCall, RegistrationStep } from "./types.ts"

/** What this client's keys register: the keystore leaf's two values and the viewing key senders encrypt to. */
export type OwnRegistration = { authDigest: bigint; nullifyingKeyHash: bigint; viewingKey: Hex }

/** The SDK's own derivations, so a spend proved under these keys finds the leaf this registers. */
export function ownRegistration(keys: Keys, notes: NoteComputationService, hash: PoseidonHashService): OwnRegistration {
	return {
		authDigest: BigInt(notes.computeAuthDigest(keys.keystore.getPrivateRevocableKey())),
		nullifyingKeyHash: BigInt(hash.hash([keys.keystore.getPrivateNullifyingKey()])),
		viewingKey: keys.keystore.getViewingKeyPair().publicKey.toLowerCase() as Hex,
	}
}

/** The reads registration needs; a fake in unit tests. */
export type RegistrationReader = Pick<RootReader, "readContract"> & { head(): Promise<bigint> }

const UNSET_VIEWING_KEY = toHex(0n, { size: 32 })

function call(owner: Address, keystore: Address, data: Hex, fn: RegistrationCall["function"]): RegistrationStep {
	return Object.freeze({ status: "send", call: Object.freeze({ function: fn, from: owner, to: keystore, data, value: 0n }) })
}

/**
 * The owner's next keystore call, from the vault's keystore and the owner's two keys read at one block:
 * the head, or `after` when the head is older, so a step asked for after a receipt in block `after`
 * never reads the chain from before it (an RPC without that block fails the read instead).
 * @throws PoolClientError `KEYSTORE_MISMATCH` when the vault reads another keystore than `pool.keystore`;
 * `REGISTERED_TO_OTHER_KEYS` when either key the keystore holds for the owner is not this client's
 */
export async function registrationStep(
	r: RegistrationReader,
	pool: Pick<PoolConfig, "poolVault" | "keystore">,
	owner: Address,
	own: OwnRegistration,
	after = 0n,
): Promise<RegistrationStep> {
	const head = await r.head()
	const at = { blockNumber: head > after ? head : after }
	const keys = { ...at, address: pool.keystore, abi: KEYSTORE_REGISTRATION_ABI, args: [owner] } as const
	const keystore = r.readContract({ ...at, address: pool.poolVault, abi: POOL_VAULT_VIEWS_ABI, functionName: "keystore" })
	const held = Promise.all([
		r.readContract({ ...keys, functionName: "nullifyingKeys" }),
		r.readContract({ ...keys, functionName: "viewingKeys" }),
	])
	// A configured keystore that is not the vault's may not answer at all: the mismatch is the error then.
	held.catch(() => {})
	if (!isAddressEqual((await keystore) as Address, pool.keystore))
		throw new PoolClientError("KEYSTORE_MISMATCH", "the pool vault reads another keystore than this client's")
	const [nullifying, viewing] = await held
	const nullifyingKeyHash = nullifying as bigint
	const viewingKey = (viewing as Hex).toLowerCase()
	const viewingSet = viewingKey !== UNSET_VIEWING_KEY
	if ((nullifyingKeyHash !== 0n && nullifyingKeyHash !== own.nullifyingKeyHash) || (viewingSet && viewingKey !== own.viewingKey))
		throw new PoolClientError("REGISTERED_TO_OTHER_KEYS", "the keystore holds another key for this owner")
	// The keystore registers `msg.sender`, refuses a second auth policy and overwrites a viewing key.
	if (nullifyingKeyHash === 0n) {
		const args = [own.authDigest, own.nullifyingKeyHash] as const
		return call(
			owner,
			pool.keystore,
			encodeFunctionData({ abi: KEYSTORE_REGISTRATION_ABI, functionName: "setAuthPolicy", args }),
			"setAuthPolicy",
		)
	}
	if (!viewingSet) {
		const args = [own.viewingKey] as const
		return call(
			owner,
			pool.keystore,
			encodeFunctionData({ abi: KEYSTORE_REGISTRATION_ABI, functionName: "setViewingKey", args }),
			"setViewingKey",
		)
	}
	return Object.freeze({ status: "registered" })
}
