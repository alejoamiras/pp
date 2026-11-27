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

/** One keystore call, deep-frozen. Send it only from `from`: the keystore registers the sender, never an argument. */
export type RegistrationCall = {
	readonly function: "setAuthPolicy" | "setViewingKey"
	readonly from: Address
	readonly to: Address
	readonly data: Hex
	readonly value: 0n
}

export type RegistrationStep = { readonly status: "registered" } | { readonly status: "send"; readonly call: RegistrationCall }

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
	/**
	 * `registered` once the keystore holds this client's nullifying-key hash and viewing key for the owner,
	 * else the one call that sets the next of them. The auth policy itself is not readable: one the owner
	 * rotated with `updateAuthPolicy` still reads `registered`, and this client's spends then fail to prove.
	 * Never sends: send the call, wait for its successful receipt, and ask again with the receipt's block
	 * as `after`. @throws PoolClientError `KEYSTORE_MISMATCH`, `REGISTERED_TO_OTHER_KEYS`
	 */
	registrationStep(after?: bigint): Promise<RegistrationStep>
}
