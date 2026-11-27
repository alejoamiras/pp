/**
 * The ports the screens and the bridge driver use. Fixtures and stack adapters both implement them,
 * and `#data` picks one at build time. The packages' contract types come from `./stack-types`; the
 * shapes for the wallet, the token calls and time are the app's own.
 */
import type { Address, Hash, Hex, TypedDataDefinition } from "viem"
import type {
	AspSnapshot,
	AztecAddress,
	BridgeRecordView,
	ExitStatus,
	ExitTicket,
	LabelState,
	Origin,
	PoolNoteView,
	RootRecord,
	StaleRootCode,
} from "./stack-types"
import type { AztecConnection, ConfirmEmoji, WalletOption } from "./wallet/types"

/** An Aztec or Ethereum send as the chain reports it. `reason` is untrusted text. */
export type Sent = { txHash: Hex; status: "success" | "reverted" | "dropped"; reason?: string }

/**
 * What one bridge spend is bound to, frozen at Submit. `assertCurrent` compares it with the live
 * context before every step that cannot be undone.
 */
export type Attempt = Readonly<{
	/** From the driver's run counter: a later Submit has a larger one. */
	seq: number
	owner: Address
	sender: Address
	recipient: AztecAddress
	deployment: string
	chainId: number
	/** The Aztec connection's epoch at Submit. */
	epoch: number
	/** The spent note's commitment. */
	note: bigint
	amount: bigint
}>

export interface L1Port {
	/** The wallet's selected account first. */
	accounts(): Promise<Address[]>
	chainId(): Promise<number>
	signTypedData(owner: Address, td: TypedDataDefinition): Promise<Hex>
	onAccountsChanged(f: (accounts: Address[]) => void): () => void
	onChainChanged(f: (chainId: number) => void): () => void
}

export interface WalletPort {
	/**
	 * Streams wallets as they answer, after checking that the node serves the target's chain.
	 * Resolves when discovery ends or `signal` aborts.
	 *
	 * @throws ConnectError `node-unreachable` or `chain-mismatch` before any wallet is probed.
	 */
	discover(onOption: (option: WalletOption) => void, signal: AbortSignal): Promise<void>
	/**
	 * Secure channel, emoji confirmation, then the stage's capability request. A newer `connect`, a
	 * `disconnect` or a remote disconnect while this one waits makes it reject with `superseded` and
	 * undo its own channel.
	 */
	connect(option: WalletOption, confirm: ConfirmEmoji): Promise<AztecConnection>
	disconnect(): Promise<void>
	/** Called once per remote disconnect of the live connection, after its epoch is superseded. */
	onDisconnect(f: () => void): () => void
}

export interface SessionPort {
	/** Asks `sign` for the secret-derivation signature, which stays inside the session. */
	open(a: { owner: Address; sign(td: TypedDataDefinition): Promise<Hex> }): Promise<Session>
	/**
	 * Deletes every bridge record this device keeps. A bridge already mined stays recoverable from the
	 * signature and the chain (`recover`); an unmined one is forgotten, so its note bridges again with no
	 * override.
	 */
	forget(): Promise<void>
}

declare const provedBrand: unique symbol
/** A proof the session made; only its display fields are readable. */
export type Proved = {
	readonly [provedBrand]: true
	readonly note: bigint
	readonly label: bigint
	readonly amount: bigint
	readonly change: bigint
}

export interface SubmitHooks {
	/** An internal re-proof started because `code`'s root moved. */
	reproving(code: StaleRootCode): void
	/** Runs right before the wallet is asked to send or sign; when it throws, nothing is sent. */
	handoff(): void
	/** The wallet returned the transaction's hash and the journal holds it; the receipt is still to come. */
	sent(txHash: Hash): void
}

export interface ClaimHooks {
	/** Runs after the claim is built and right before the Aztec wallet is asked to send. */
	handoff(): void
}

/** Opaque: the bridge session, the signature and every proof stay inside the implementation. */
export interface Session {
	readonly owner: Address
	notes(): Promise<PoolNoteView[]>
	/** The nullifier spending `commitment` would publish (the pool client's `nullifierOf`); ties a record to its note. */
	nullifierOf(commitment: bigint): Promise<bigint>
	/** Binds the client to `recipient` for 10 minutes; one send consumes it. */
	preflight(recipient: AztecAddress): Promise<void>
	/** Derives what the first proof needs once, so Submit does not wait on it. */
	warmUp(): Promise<void>
	prove(a: Attempt): Promise<Proved>
	/** Ends an unsettled `prove` (it rejects) and readies a fresh prover; nothing is reopened. */
	cancelProve(): void
	/**
	 * Re-proves at most twice inside, each re-proof under the same deadline as `prove`. An earlier
	 * attempt of the note decides first: `IN_FLIGHT` while its transaction is pending at the RPC, and
	 * `UNCERTAIN` while it has no hash or one the RPC does not know, unless `acceptUncertain`, which every
	 * later submit needs again until the chain shows the bridge. A wallet refusal before broadcast (4001)
	 * leaves the journal as it was. @throws BridgeClientError
	 */
	submit(p: Proved, a: Attempt, on: SubmitHooks, o?: { acceptUncertain?: true }): Promise<BridgeRecordView>
	waitClaimable(id: string, signal: AbortSignal): Promise<void>
	/** Sends from the record's recipient. */
	claim(id: string, on: ClaimHooks): Promise<Sent>
	/** This device's journal, unmined records included. */
	records(): Promise<BridgeRecordView[]>
	/** Unclaimed bridges to `recipient`, with the same ids as `records()`. */
	recover(recipient: AztecAddress): Promise<BridgeRecordView[]>
	/** What the Ethereum RPC knows of a journal record's hash. */
	l1TxState(hash: Hash): Promise<L1TxState>
	close(): void
}

/** `pending`: in the RPC's pool, not mined; `unknown`: the RPC has no such transaction (never sent, or dropped). */
export type L1TxState = "pending" | "mined" | "unknown"

export interface LabelBalance {
	label: bigint
	origin: Origin
	balance: bigint
}

/** Every send names its account and pays with SponsoredFPC, all through the wallet. */
export interface AztecPort {
	balancesByLabel(owner: AztecAddress): Promise<LabelBalance[]>
	/** Note values, largest first. */
	notesByLabel(owner: AztecAddress, label: bigint): Promise<bigint[]>
	publicBalance(owner: AztecAddress): Promise<bigint>
	transferPrivate(from: AztecAddress, a: { to: AztecAddress; amount: bigint; label: bigint; origin: Origin }): Promise<Sent>
	unshield(from: AztecAddress, a: { amount: bigint; label: bigint; origin: Origin }): Promise<Sent>
	shield(from: AztecAddress, amount: bigint): Promise<Sent>
	/** Re-derives the one exact chunk (at most 8 largest notes) equal to `amount`, else refuses with `NO_EXACT_CHUNKS`. */
	ragequit(from: AztecAddress, a: { payee: Address; label: bigint; amount: bigint }): Promise<Sent>
	exitPublic(from: AztecAddress, a: { payee: Address; amount: bigint }): Promise<Sent>
}

/** Identical exits in one transaction differ only by their message index. */
export interface ExitKey {
	deployment: string
	l2TxHash: Hex
	messageIndexInTx: number
}
export interface ExitView {
	key: ExitKey
	ticket: ExitTicket
	status: ExitStatus
}
export interface ExitPort {
	tickets(payee: Address): Promise<ExitView[]>
	settle(t: ExitTicket, sender: Address): Promise<Hash>
}

/** One record and the snapshot it names, read at one anchor block. */
export interface AllowListView {
	record: RootRecord
	snapshot: AspSnapshot
}
export interface AllowListPort {
	current(): Promise<AllowListView>
	state(view: AllowListView, label: bigint, origin: Origin, nowSec: bigint): LabelState
}

/** Latest block timestamps in seconds: chain time, which on a local chain moves only with blocks. Never `Date.now()`. */
export interface ChainClock {
	aztecNow(): Promise<bigint>
	l1Now(): Promise<bigint>
}

/** Waits that are not chain time (the prove deadline, the preflight's age), injected so tests run them virtually. */
export interface Timer {
	/** Milliseconds on a monotonic clock. */
	now(): number
	/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts; never rejects. */
	sleep(ms: number, signal?: AbortSignal): Promise<boolean>
}

/** Which token functions a deployment has: stage A, B or C of the labelled token. */
export type Stage = "2a" | "2b" | "2c"

export interface Deployment {
	/** `chainId:portal:hub`, lower case. */
	readonly id: string
	readonly chainId: number
	readonly stage: Stage
	readonly portal: Address
	readonly hub: AztecAddress
	readonly token: AztecAddress
	readonly sponsoredFpc: AztecAddress
	readonly decimals: number
	readonly symbol: string
}
