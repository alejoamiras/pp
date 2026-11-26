import type { AztecAddress } from "../a7"

/** One discovered wallet. `key` is per announcement: any wallet can claim any id or name. */
export interface WalletOption {
	readonly key: number
	readonly id: string
	/** Sanitized; still untrusted text, rendered by interpolation only. */
	readonly name: string
	/** A `data:image/png` or `data:image/webp` URI, or absent. */
	readonly icon?: string
	readonly kind: "extension" | "web"
}

/**
 * What the app may do with the wallet: the request intersected with the answer. A contract counts only
 * when every scope requested on it came back; a wildcard on either side grants nothing.
 */
export interface Grant {
	readonly accounts: readonly AztecAddress[]
	/** Contracts the app may register and call, in request order. */
	readonly contracts: readonly AztecAddress[]
	/** `scopeKey` of every requested function scope the wallet granted. */
	readonly scopes: ReadonlySet<string>
}

export interface AztecConnection {
	/** The connector run this connection belongs to; a later connect, disconnect or remote disconnect supersedes it. */
	readonly epoch: number
	readonly walletName: string
	/** Granted accounts, canonical and deduplicated, in the wallet's order. */
	readonly accounts: readonly AztecAddress[]
	readonly grant: Grant
}

/** Shows the user the verification grid; resolves whether it matches the wallet's. */
export type ConfirmEmoji = (emoji: readonly string[]) => Promise<boolean>

export type ConnectErrorCode =
	| "node-unreachable"
	| "chain-mismatch"
	| "no-wallet"
	| "emoji-mismatch"
	| "rejected"
	| "denied"
	| "unauthorized"
	| "disconnected"
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
export const noAccountsError = () => new ConnectError("no-accounts", "The wallet granted no account. Allow at least one, then try again.")

const GENERIC = "Something went wrong while connecting. Try again."

export function connectErrorMessage(err: unknown): string {
	return err instanceof ConnectError ? err.message : GENERIC
}
