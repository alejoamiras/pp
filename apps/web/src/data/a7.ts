/**
 * Type-only mirror of the A7 shapes the app reads (`@pp/bridge-core`, `@pp/pool-client`,
 * `@pp/label-paths`), until those packages land and this file becomes re-exports. Nothing here has
 * a runtime value.
 *
 * One deliberate difference: `AztecAddress` is a branded canonical hex string, not aztec.js's class.
 * Importing that class at runtime pulls bb.js and its wasm (about 11 MB) into every bundle, so the
 * screens and the fixture world carry the string and the stack adapters convert at their boundary.
 */
import type { Address, Hash, Hex, TypedDataDefinition, WalletClient } from "viem"

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** 0x + 64 lower-case hex digits, below the BN254 scalar modulus. Curve validity is not implied. */
export type AztecAddress = Brand<Hex, "AztecAddress">

export interface StackManifest {
	version: 1
	chainId: number
	l1Rpc: string
	aztecNode: string
	pool: {
		poolVault: Address
		entrypoint: Address
		aspRegistry: Address
		keystore: Address
		asset: Address
		deployBlock: bigint
		aspApiUrl: string
	}
	bridge?: { factory: Address; portal: Address; hub: AztecAddress; token: AztecAddress; registry: AztecAddress; deployBlock: bigint }
	bot?: { url: string; poster: AztecAddress; birthIntake: AztecAddress }
	artifacts?: { baseUrl: string }
}

export type PoolNoteStatus = "inactive" | "pending" | "approved" | "revoked" | "spent" | "exiting" | "exited"
export interface PoolNoteView {
	commitment: bigint
	label: bigint
	value: bigint
	asset: Address
	status: PoolNoteStatus
}

export type StaleRootCode = "STATE_ROOT_STALE" | "KEYSTORE_ROOT_STALE" | "ASP_ROOT_STALE"
export type ChangeOpening = { commitment: bigint; precommitment: bigint; label: bigint; value: bigint }

/** The pool SDK's proof and note data; the app never looks inside. */
type Opaque<B extends string> = { readonly [brand]: B }
export type PreparedSpend = {
	proof: Opaque<"TransactProof">
	noteData: readonly Opaque<"NoteData">[]
	processor: Address
	data: Hex
	nullifier: bigint
	spentCommitment: bigint
	change: ChangeOpening
	amount: bigint
	asset: Address
	aspRoot: bigint
}

export interface PoolClient {
	notes(): Promise<PoolNoteView[]>
	prepareSpend(a: { note: bigint; amount: bigint; processor: Address; data: Hex }): Promise<PreparedSpend>
	assertFresh(s: PreparedSpend): Promise<void>
	changeOpening(spentNullifier: bigint): Promise<ChangeOpening>
	nullifierOf(commitment: bigint): Promise<bigint>
	assertRecoverable(s: PreparedSpend): Promise<void>
}
export type SecretDerivationTypedData = (l1Address: Address) => TypedDataDefinition

/** Opaque: only `openBridgeSession` builds one, and the claim key never leaves it. */
export interface BridgeSession {
	readonly pool: PoolClient
	readonly l1Address: Address
}
export type PreparedBridgeSpend = PreparedSpend & { secretHash: Hex; claimSalt: bigint; recipient: AztecAddress }
export type BridgeReceipt = {
	l1TxHash: Hash
	portal: Address
	messageKey: Hex
	leafIndex: bigint
	nullifier: bigint
	changeCommitment: bigint
	amount: bigint
	asset: Address
}
export type BridgeStep = "prepared" | "submitted" | "mined" | "claimable" | "claiming" | "claimed" | { error: string }
export type ExitTicket =
	| { kind: "ragequit"; token: AztecAddress; payee: Address; amount: bigint; label: bigint; l2TxHash: Hex; messageIndexInTx: number }
	| { kind: "public"; token: AztecAddress; payee: Address; amount: bigint; l2TxHash: Hex; messageIndexInTx: number }

/** `id` equals `recover`'s id for the same nullifier; a reverted send reads `{ error: "REVERTED" }`. */
export type BridgeRecordView = {
	id: string
	nullifier: bigint
	recipient: AztecAddress
	amount: bigint
	l1TxHash?: Hash
	step: BridgeStep
	receipt?: BridgeReceipt
}

export type SpendCheckName =
	| "shape"
	| "request"
	| "params"
	| "public"
	| "nullifier"
	| "change"
	| "context"
	| "salt"
	| "secretHash"
	| "data"
	| "processor"
	| "asset"
	| "recipient"

/** Closed set. */
export type BridgeClientErrorCode =
	| "FORGED_SESSION"
	| "SESSION_DEPLOYMENT_MISMATCH"
	| "DEPLOYMENT_MISMATCH"
	| "CHAIN_MISMATCH"
	| "RECIPIENT_INVALID"
	| "RECIPIENT_NOT_IN_WALLET"
	| "FEE_PATH_FAILED"
	| "PREFLIGHT_REQUIRED"
	| "SPEND_MISMATCH"
	| "SENDER_IS_OWNER"
	| "IN_FLIGHT"
	| "UNCERTAIN"
	| "STALE"
	| "SIMULATION_REVERTED"
	| "REVERTED"
	| "CONSUMED_ELSEWHERE"
	| "NOTE_NOT_FOUND"
	| "OPENING_MISMATCH"
	| "NOT_CLAIMABLE"
	| "EXIT_NOT_READY"
	| "STAGE_UNSUPPORTED"
	| "TICKET_NOT_FOUND"
	| "NO_EXACT_CHUNKS"
	| "RPC_FAILED"
	| "RPC_INCONSISTENT"

/** `source` and `revert` are allow-listed identifiers; no field carries a lower message or a secret. */
export interface BridgeClientError extends Error {
	readonly code: BridgeClientErrorCode
	readonly check?: SpendCheckName
	readonly stale?: StaleRootCode | null
	readonly revert?: string
	readonly source?: string
	readonly l1TxHash?: Hash
}

export type AztecWallet = Opaque<"AztecWallet">
export type ExecutionPayload = Opaque<"ExecutionPayload">
export type ExitStatus = "proving" | "ready" | "settled"

export interface BridgeClient {
	preflight(a: { recipient: AztecAddress; wallet: AztecWallet }): Promise<void>
	submit(
		spend: PreparedBridgeSpend,
		l1: WalletClient,
		s: BridgeSession,
		o?: { onReprove?: (code: StaleRootCode) => void; acceptUncertain?: boolean },
	): Promise<BridgeReceipt>
	waitClaimable(r: BridgeReceipt, o?: { forceBlock?: () => Promise<void>; signal?: AbortSignal }): Promise<void>
	claimPayload(s: BridgeSession, r: BridgeReceipt): Promise<ExecutionPayload>
	ragequitPayload(a: { payee: Address; amount: bigint; label: bigint }): Promise<ExecutionPayload>
	exitPublicPayload(a: { payee: Address; amount: bigint }): Promise<ExecutionPayload>
	exitTickets(a: { payee?: Address; fromBlock?: bigint }): Promise<ExitTicket[]>
	exitStatus(e: ExitTicket): Promise<ExitStatus>
	settle(e: ExitTicket, l1: WalletClient): Promise<Hash>
	recover(s: BridgeSession, recipient: AztecAddress): Promise<(BridgeReceipt & { id: string })[]>
	records(s: BridgeSession): Promise<BridgeRecordView[]>
}

/** Exact chunks only: each a descending prefix of at most 8 whole notes; otherwise `NO_EXACT_CHUNKS`. */
export type RagequitChunks = (noteValues: readonly bigint[], amount?: bigint) => bigint[]

/** Leaves are `hash_1(label)`; root 0 means an empty list. */
export type AspSnapshot = { sequence: bigint; poolRoot: bigint; birthRoot: bigint; poolLeaves: bigint[]; birthLeaves: bigint[] }
export type RootRecord = { sequence: bigint; poolRoot: bigint; birthRoot: bigint; l1Block: bigint; rootTime: bigint }
export type LabelState = "ACTIVE" | "ABSENT" | "STALE_ROOT"
/** 0: minted from the bridge (pool tree); 1: born on Aztec by a shield (birth tree). */
export type Origin = 0 | 1
export type LabelStateFn = (r: RootRecord, s: AspSnapshot, label: bigint, origin: Origin, nowSec: bigint) => LabelState
/** `at` is a block number or hash; every slot is read at that one block. */
export type ReadRootRecord = (a: { aztecNode: string; registry: Hex; at?: number | Hex }) => Promise<RootRecord>
