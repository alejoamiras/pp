import { type Address, decodeErrorResult, type Hex } from "viem"
import { ASP_REGISTRY_VIEWS_ABI, KEYSTORE_VIEWS_ABI, POOL_VAULT_ERRORS_ABI, POOL_VAULT_VIEWS_ABI } from "./abi.ts"
import type { PoolConfig, StaleRoot } from "./types.ts"

/**
 * A superseded keystore root dies `keystoreRootLiveness` (1200 s) of chain time after it is replaced. One
 * with this little left is reported stale, so the caller re-proves before broadcasting rather than after
 * a revert.
 */
export const KEYSTORE_ROOT_MARGIN_SECONDS = 120n

export type RootReads = { stateKnown: boolean; keystoreCurrent: bigint; keystoreValidUntil: bigint; aspLatest: bigint; timestamp: bigint }
export type ProofRoots = { state: bigint; keystore: bigint; asp: bigint }

export function staleRoot(roots: ProofRoots, r: RootReads): StaleRoot | null {
	if (!r.stateKnown) return "STATE_ROOT_STALE"
	if (roots.keystore !== r.keystoreCurrent && r.keystoreValidUntil <= r.timestamp + KEYSTORE_ROOT_MARGIN_SECONDS)
		return "KEYSTORE_ROOT_STALE"
	if (roots.asp !== r.aspLatest) return "ASP_ROOT_STALE"
	return null
}

type ReadCall = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber: bigint }
/** The two viem calls the reads need; a fake in unit tests. */
export type RootReader = {
	getBlock(): Promise<{ number: bigint | null; timestamp: bigint }>
	readContract(call: ReadCall): Promise<unknown>
}

/** All four views at one block, so the answer describes a single chain state. */
export async function readRoots(client: RootReader, pool: PoolConfig, roots: ProofRoots): Promise<RootReads> {
	const block = await client.getBlock()
	if (block.number === null) throw new Error("the latest block has no number")
	const at = { blockNumber: block.number }
	const [stateKnown, keystoreCurrent, keystoreValidUntil, aspLatest] = await Promise.all([
		client.readContract({
			...at,
			address: pool.poolVault,
			abi: POOL_VAULT_VIEWS_ABI,
			functionName: "isKnownRoot",
			args: [roots.state],
		}),
		client.readContract({ ...at, address: pool.keystore, abi: KEYSTORE_VIEWS_ABI, functionName: "currentRoot" }),
		client.readContract({
			...at,
			address: pool.keystore,
			abi: KEYSTORE_VIEWS_ABI,
			functionName: "previousRoots",
			args: [roots.keystore],
		}),
		client.readContract({ ...at, address: pool.aspRegistry, abi: ASP_REGISTRY_VIEWS_ABI, functionName: "latestASPRoot" }),
	])
	return {
		stateKnown: stateKnown as boolean,
		keystoreCurrent: keystoreCurrent as bigint,
		keystoreValidUntil: keystoreValidUntil as bigint,
		aspLatest: aspLatest as bigint,
		timestamp: block.timestamp,
	}
}

const REVERT_CODES: Readonly<Record<string, StaleRoot>> = {
	PoolVault_UnknownStateRoot: "STATE_ROOT_STALE",
	PoolVault_UnknownKeystoreRoot: "KEYSTORE_ROOT_STALE",
	PoolVault_InvalidASPRoot: "ASP_ROOT_STALE",
}

/**
 * Maps a `transact` revert to the stale root that caused it, or `null` for any other revert. It matches by
 * selector, and a processor can revert with the same bytes: a hint to re-prove, not proof.
 */
export function spendRevertCode(revertData: Hex): StaleRoot | null {
	try {
		return REVERT_CODES[decodeErrorResult({ abi: POOL_VAULT_ERRORS_ABI, data: revertData }).errorName] ?? null
	} catch {
		return null
	}
}
