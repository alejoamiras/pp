/** One discovered wallet. `key` is per announcement: any wallet can claim any id or name. */
export interface WalletOption {
	readonly key: number
	readonly id: string
	/** Sanitized; still untrusted text, rendered by interpolation only. */
	readonly name: string
	readonly kind: "extension" | "web"
}

export interface AztecConnection {
	/** The connector run this connection belongs to; a later connect or disconnect supersedes it. */
	readonly epoch: number
	readonly walletName: string
	/** Granted accounts, canonical and deduplicated, in the wallet's order. */
	readonly accounts: readonly string[]
}

/** Shows the user the verification grid; resolves whether it matches the wallet's. */
export type ConfirmEmoji = (emoji: readonly string[]) => Promise<boolean>

export interface WalletConnector {
	/**
	 * Streams wallets as they answer, after checking that the node serves the target's chain.
	 * Resolves when discovery ends or `signal` aborts.
	 *
	 * @throws ConnectError `node-unreachable` or `chain-mismatch` before any wallet is probed.
	 */
	discover(onOption: (option: WalletOption) => void, signal: AbortSignal): Promise<void>
	/**
	 * Secure channel, emoji confirmation, then the grant. A newer `connect` or a `disconnect` while
	 * this one waits makes it reject with `superseded` and undo its own channel.
	 */
	connect(option: WalletOption, confirm: ConfirmEmoji): Promise<AztecConnection>
	disconnect(): Promise<void>
}

export type ConnectErrorCode =
	| "node-unreachable"
	| "chain-mismatch"
	| "no-wallet"
	| "emoji-mismatch"
	| "rejected"
	| "no-accounts"
	| "superseded"

/** The only errors whose text reaches the screen; anything else shows a generic line. */
export class ConnectError extends Error {
	constructor(
		readonly code: ConnectErrorCode,
		message: string,
	) {
		super(message)
		this.name = "ConnectError"
	}
}

export const supersededError = () => new ConnectError("superseded", "A newer connection attempt replaced this one.")
export const emojiMismatchError = () => new ConnectError("emoji-mismatch", "The codes did not match, so nothing was connected. Try again.")

const GENERIC = "Something went wrong while connecting. Try again."

export function connectErrorMessage(err: unknown): string {
	return err instanceof ConnectError ? err.message : GENERIC
}
