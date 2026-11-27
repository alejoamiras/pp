import { type ArtifactSource, type PreparedSpend as ClientSpend, type PoolConfig, PoolClientError } from "@pp/pool-client"
import { type Address, getAddress, type Hex } from "viem"
import type { ClientConfig, PreparedSpend } from "./types.ts"

/** The viem boundary: the two sides run different viem copies, so only plain data crosses and pool-client builds its own RPC client from `pool.l1Rpc`. */
export function poolClientOptions(
	config: ClientConfig,
	asset: Address,
	owner: Address,
	signature: Hex,
): { pool: PoolConfig; l1Address: Address; signature: Hex; artifacts: ArtifactSource } {
	const d = config.deployment
	return {
		pool: {
			chainId: config.chainId,
			l1Rpc: config.rpcUrl,
			poolVault: d.pool,
			entrypoint: d.entrypoint,
			aspRegistry: d.aspRegistry,
			keystore: d.keystore,
			asset,
			deployBlock: d.deployBlock,
			aspApiUrl: config.aspUrl,
		},
		l1Address: owner,
		signature,
		artifacts: { kind: "dir", path: config.circuitsDir },
	}
}

/** pool-client's checked spend in `PoolUser`'s shape; `args` is `transact`'s arguments, to forward unchanged. */
export function toPreparedSpend(s: ClientSpend): PreparedSpend {
	return {
		args: [s.proof, { processor: s.processor, data: s.data }, s.noteData],
		input: s.spentCommitment,
		nullifier: s.nullifier,
		changeCommitment: s.change.commitment,
		changeValue: s.change.value,
		amountOut: s.amount,
		asset: getAddress(s.asset),
		label: s.change.label,
	}
}

/**
 * `NOTE_NOT_FOUND` for a note this user lists as active is a mismatch between two discoveries on
 * their own cursors (ASP events, RPC lag), not a missing deposit; the code is kept, the message says so.
 */
export function explainSpendError(e: unknown, commitment: bigint): unknown {
	if (!(e instanceof PoolClientError) || e.code !== "NOTE_NOT_FOUND") return e
	return new PoolClientError(
		"NOTE_NOT_FOUND",
		`note ${commitment} is ACTIVE in this user's notes, but pool-client's own discovery has not found it`,
	)
}
