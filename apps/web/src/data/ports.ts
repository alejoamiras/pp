/**
 * The ports the screens and the bridge driver use. Fixtures and stack adapters both implement them,
 * and `#data` picks one at build time. The packages' contract types come from `./stack-types`; the
 * shapes for the wallet, the token calls and time are the app's own.
 */
import type { Address, Hash, Hex, TypedDataDefinition } from "viem"
import type {
	LabelCheck,
	AztecAddress,
	BridgeRecordView,
	ExitStatus,
	ExitTicket,
	Origin,
	PoolNoteView,
	RootRecord,
	StaleRootCode,
} from "./stack-types"
import type { AztecConnection, ConfirmEmoji, WalletOption } from "./wallet/types"

/**
 * An Aztec send as the chain reports it. `reason` is untrusted text; `block` is the block a reverted
 * send landed in, which the finality wait compares with the node's proven block.
 */
/** `unconfirmed`: the wallet returned the hash, but its outcome could not be read. */
export type Sent =
	| { txHash: Hex; status: "success" | "dropped"; reason?: string }
	/** The wallet may have sent it and the page could not read whether it landed; no `txHash` when the wallet's send threw. */
	| { txHash?: Hex; status: "unconfirmed" }
	| { txHash: Hex; status: "reverted"; block: number; reason?: string }

/**
 * What one bridge spend is bound to, frozen at Submit. `assertCurrent` compares it with the live
 * context before every step that cannot be undone.
 */
export type Attempt = Readonly<{
	/** From the driver's run counter: a later Submit has a larger one. */
	seq: number
	owner: Address
	sender: Address
	/** Whether the page chose the local demo's dev account as the sender; only such an attempt sends through it. */
	demo: boolean
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
	/** The wallet's selected account first; none until the wallet shares one with this origin. */
	accounts(): Promise<Address[]>
	/**
	 * Asks the wallet to share its accounts with this origin (`eth_requestAccounts`), which may prompt
	 * the user; only on a user's click. @throws `NO_SENDER` with no wallet, the wallet's 4001 on a no.
	 */
	requestAccounts(): Promise<Address[]>
	/** Whether the page found an Ethereum wallet at all; one with no shared account can still be asked. */
	readonly hasWallet: boolean
	chainId(): Promise<number>
	signTypedData(owner: Address, td: TypedDataDefinition): Promise<Hex>
	onAccountsChanged(f: (accounts: Address[]) => void): () => void
	onChainChanged(f: (chainId: number) => void): () => void
	/** A local-stack build's dev account, which a bridge may send from with no wallet once `ready` resolves. */
	readonly demo?: { readonly address: Address; ready(): Promise<void> }
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
	/** The wallet returned the transaction's hash; the receipt is still to come. */
	sent(txHash: Hash): void
}

/** What one Aztec send is bound to, from the moment the user asked for it. */
export interface AztecSendHooks {
	/** The Aztec connection the send is bound to: it goes out through that connection's wallet or not at all. */
	readonly epoch: number
	/** Runs after the send is built and right before the Aztec wallet is asked to send; when it throws, nothing is sent. */
	handoff(): void
}

export type ClaimHooks = AztecSendHooks

/** Opaque: the bridge session, the signature and every proof stay inside the implementation. */
export interface Session {
	readonly owner: Address
	notes(): Promise<PoolNoteView[]>
	/** The nullifier spending `commitment` would publish (the pool client's `nullifierOf`); ties a record to its note. */
	nullifierOf(commitment: bigint): Promise<bigint>
	/** Binds the client to `recipient` in connection `epoch`'s wallet for 10 minutes; one send consumes it. */
	preflight(recipient: AztecAddress, epoch: number): Promise<void>
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

/**
 * `mined` and `reverted`: the receipt's status; `pending`: in the RPC's pool, not mined; `unknown`: the
 * RPC has no such transaction (never sent, or dropped).
 */
export type L1TxState = "pending" | "mined" | "reverted" | "unknown"

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
	/**
	 * A checked spend: its label path comes from the allow list right before it is sent.
	 * @throws `OVER_NOTE_CAP` before the handoff when one transaction cannot spend `amount` from the
	 *   label's notes as read after that check (`spendCap`)
	 */
	transferPrivate(
		from: AztecAddress,
		a: { to: AztecAddress; amount: bigint; label: bigint; origin: Origin },
		on: AztecSendHooks,
	): Promise<Sent>
	/** A checked spend, as `transferPrivate`. */
	unshield(from: AztecAddress, a: { amount: bigint; label: bigint; origin: Origin }, on: AztecSendHooks): Promise<Sent>
	/**
	 * Public balance into a new birth note under a fresh label; it spends no label, so no path is read.
	 * @throws `OVER_PUBLIC_BALANCE` before the handoff when the public balance, read again, is below `amount`
	 */
	shield(from: AztecAddress, amount: bigint, on: AztecSendHooks): Promise<Sent>
	/**
	 * Re-derives the one exact chunk (at most 8 largest notes) equal to `amount` from the notes as they
	 * are right before sending, else refuses with `NO_EXACT_CHUNKS`.
	 */
	ragequit(from: AztecAddress, a: { payee: Address; label: bigint; amount: bigint }, on: AztecSendHooks): Promise<Sent>
	exitPublic(from: AztecAddress, a: { payee: Address; amount: bigint }, on: AztecSendHooks): Promise<Sent>
	/**
	 * A checked spend that unshields `amount` of the label and exits it to `payee` in one transaction,
	 * so the label never reaches Ethereum; the account is public on Aztec. Reverts whole if the label's
	 * roots changed before its public step.
	 */
	unshieldAndExit(
		from: AztecAddress,
		a: { payee: Address; amount: bigint; label: bigint; origin: Origin },
		on: AztecSendHooks,
	): Promise<Sent>
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
	/**
	 * Sends from `from.sender`, through the local demo's dev account only when `from.demo` names the
	 * page's choice of it, or returns the transaction that already settled `t`.
	 */
	settle(t: ExitTicket, from: Pick<Attempt, "sender" | "demo">, on: Pick<SubmitHooks, "handoff">): Promise<Hash>
}

/** The registry's record and the time of the Aztec block it was read at: one anchor. */
export interface AllowListView {
	record: RootRecord
	/** The anchor block's timestamp: chain time. */
	nowSec: bigint
}

/** The running check's tree build: `hashed` of `total` hashes. */
/** A running check; `total` is 0 until a tree build starts, while the list downloads and loads. */
export interface AllowListProgress {
	hashed: number
	total: number
}

export interface AllowListPort {
	/** The record and its time, both read at one block. */
	current(): Promise<AllowListView>
	/**
	 * `label`'s state in its origin's list under `view`'s record, with its path when `ACTIVE`, from the
	 * snapshot of that record's roots. A label the list does not hold is `ABSENT` with no tree built.
	 * Checks run one at a time, in call order. A list that failed (`LIST_TIMEOUT`, `LIST_MISMATCH`,
	 * `LIST_OVERSIZED`, `LIST_CANCELLED`) keeps failing at once, with no work, until `checkAgain`.
	 * @throws AllowListError
	 */
	check(view: AllowListView, label: bigint, origin: Origin): Promise<LabelCheck>
	/** Called with the running check's progress whenever it moves, and `null` once nothing hashes. */
	onProgress(f: (p: AllowListProgress | null) => void): () => void
	/** Stops the running check and every queued one: each rejects with `LIST_CANCELLED`. */
	cancel(): void
	/** Lets the next check of `view`'s list try again, once the failure's backoff has passed; whether it did. */
	checkAgain(view: AllowListView): boolean
}

/** Latest block timestamps in seconds: chain time, which on a local chain moves only with blocks. Never `Date.now()`. */
export interface ChainClock {
	aztecNow(): Promise<bigint>
	l1Now(): Promise<bigint>
	/** The Aztec node's proven block number: every block up to it is covered by an epoch proof on Ethereum. */
	aztecProven(): Promise<number>
}

/** An Aztec transaction as the page's node reads it now: `pending` covers pending, dropped and unknown, none of them final. */
export type AztecReceipt = { status: "success" } | { status: "reverted"; block: number } | { status: "pending" }

export interface ReceiptPort {
	/** @throws on a failed read, which tells the page nothing */
	aztec(txHash: Hex): Promise<AztecReceipt>
}

/** Waits that are not chain time (the prove deadline, the preflight's age), injected so tests run them virtually. */
export interface Timer {
	/** Milliseconds on a monotonic clock. */
	now(): number
	/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts; never rejects. */
	sleep(ms: number, signal?: AbortSignal): Promise<boolean>
}

/** Which functions a deployment has: the labelled token's stages A to C, then the hub's public exit (2d). */
export type Stage = "2a" | "2b" | "2c" | "2d"

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
