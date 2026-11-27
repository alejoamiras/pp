import type { Address, Hex } from "viem"

export type PoolConfig = {
	chainId: number
	l1Rpc: string
	poolVault: Address
	entrypoint: Address
	aspRegistry: Address
	keystore: Address
	asset: Address
	deployBlock: bigint
	aspApiUrl: string
}

/** `pending` covers both a label under review and one the ASP declined: the set cannot tell them apart. */
export type NoteStatus = "inactive" | "pending" | "approved" | "revoked" | "spent" | "exiting" | "exited"

export type PoolNoteView = { commitment: bigint; label: bigint; value: bigint; asset: Address; status: NoteStatus }

export type TransactProof = {
	pA: readonly [bigint, bigint]
	pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]]
	pC: readonly [bigint, bigint]
	pubSignals: readonly (readonly bigint[])[]
}

export type NoteData = { hint: Hex; data: Hex }

/** `commitment == Poseidon(precommitment, label)`. */
export type ChangeOpening = { commitment: bigint; precommitment: bigint; label: bigint; value: bigint }

/** Deep-frozen. Forward `proof`, `{processor, data}` and `noteData` unchanged: the proof's context binds them. */
export type PreparedSpend = {
	proof: TransactProof
	noteData: readonly NoteData[]
	processor: Address
	data: Hex
	nullifier: bigint
	spentCommitment: bigint
	change: ChangeOpening
	amount: bigint
	asset: Address
	aspRoot: bigint
}

export type SpendRequest = { note: bigint; amount: bigint; processor: Address; data: Hex }

export type StaleRoot = "STATE_ROOT_STALE" | "KEYSTORE_ROOT_STALE" | "ASP_ROOT_STALE"

export interface PoolClient {
	/** Syncs, then lists this client's notes, zero-value change included. */
	notes(): Promise<PoolNoteView[]>
	/** Proves a one-input spend of `amount` to `processor` with `data`; the rest returns as change. Never submits. */
	prepareSpend(a: SpendRequest): Promise<PreparedSpend>
	/** The change of the spend that published `spentNullifier`, recovered from chain logs alone. */
	changeOpening(spentNullifier: bigint): Promise<ChangeOpening>
	/** For a note this client holds; `NOTE_NOT_FOUND` otherwise. */
	nullifierOf(commitment: bigint): Promise<bigint>
	/** Re-runs every spend check on `s`, change decryption included. */
	assertRecoverable(s: PreparedSpend): Promise<void>
	/** Throws a stale-root code if the vault would refuse `s`'s roots at the latest block. Call right before broadcasting. */
	assertFresh(s: PreparedSpend): Promise<void>
}
