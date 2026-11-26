// The user side's public types. No SDK import, so dependents typecheck without the pool checkout.
import type { Account, Address, Chain, Hex, Transport, WalletClient } from "viem"
import type { TransactArgs } from "./abi.ts"

export type ClientDeployment = { pool: Address; entrypoint: Address; keystore: Address; aspRegistry: Address; deployBlock: bigint }

/** Everything the user side needs to reach a deployed pool; nothing here is harness-specific. */
export type ClientConfig = { rpcUrl: string; chainId: number; deployment: ClientDeployment; aspUrl: string; circuitsDir: string }

/** The SDK's `NoteStatus` values; a conformance check keeps the two in step. */
export type NoteStatusName = "INACTIVE" | "PENDING" | "ACTIVE" | "SPENT" | "EXIT_PENDING" | "EXITED" | "REJECTED"

export type PoolNote = { commitment: bigint; label: bigint; value: bigint; asset: Address; status: NoteStatusName }

export type PreparedSpend = {
	/** Forward unchanged: the proof's context binds `params` and `noteData`. */
	args: TransactArgs
	input: bigint
	nullifier: bigint
	changeCommitment: bigint
	changeValue: bigint
	amountOut: bigint
	asset: Address
	label: bigint
}

export type SpendRequest = { processor: Address; data: Hex; asset: Address; amountOut: bigint; input?: bigint }

export interface PoolUser {
	address: Address
	registerKeystore(): Promise<void>
	deposit(p: { asset: Address; value: bigint }): Promise<{ label: bigint; commitment: bigint }>
	/** Scans the chain for this user's notes, spends and change. */
	sync(): Promise<void>
	notes(): PoolNote[]
	/**
	 * Proves a one-input spend that pays `amountOut` of `asset` to `processor` and returns the
	 * rest to the user as change, possibly zero. Spends `input` if given, else the largest active note.
	 */
	prepareSpend(p: SpendRequest): Promise<PreparedSpend>
}

export type LocalWallet = WalletClient<Transport, Chain, Account>

export type SecretDerivationTypedData = {
	domain: { name: "Standardized Secret Derivation"; version: "1"; verifyingContract: Address; salt: Hex }
	types: { SecretDerivation: readonly [{ name: "purpose"; type: "string" }, { name: "addressHash"; type: "bytes32" }] }
	primaryType: "SecretDerivation"
	message: { purpose: string; addressHash: Hex }
}
