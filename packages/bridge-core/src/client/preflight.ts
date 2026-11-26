import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { BridgeClientError } from "./errors"

/** What a passing preflight keeps of the Aztec wallet: enough to ask again whether it holds the recipient. */
export type AccountLister = { getAccounts(): Promise<readonly { item: { toString(): string } }[]> }

export const PREFLIGHT_TTL_MS = 10 * 60_000

type Entry = { wallet: AccountLister; expiry: number }

const required = () => new BridgeClientError("PREFLIGHT_REQUIRED")

/**
 * Which recipients passed preflight on this client, per deployment, for ten minutes. In memory only,
 * so a reload preflights again. `submit` checks for an entry early and consumes it right before the
 * Ethereum wallet call, after asking the same Aztec wallet again whether it still lists the recipient.
 */
export class Preflights {
	readonly #entries = new Map<string, Entry>()
	readonly #now: () => number

	constructor(now: () => number = Date.now) {
		this.#now = now
	}

	#key(deployment: string, recipient: AztecAddress): string {
		return `${deployment}|${recipient.toString().toLowerCase()}`
	}

	#live(key: string): Entry | undefined {
		const entry = this.#entries.get(key)
		if (entry && entry.expiry > this.#now()) return entry
		this.#entries.delete(key)
		return undefined
	}

	record(deployment: string, recipient: AztecAddress, wallet: AccountLister): void {
		this.#entries.set(this.#key(deployment, recipient), { wallet, expiry: this.#now() + PREFLIGHT_TTL_MS })
	}

	/** @throws BridgeClientError `PREFLIGHT_REQUIRED` without a live entry */
	require(deployment: string, recipient: AztecAddress): void {
		if (!this.#live(this.#key(deployment, recipient))) throw required()
	}

	/** @throws BridgeClientError `PREFLIGHT_REQUIRED` when the entry expired or its wallet no longer lists the recipient */
	async consume(deployment: string, recipient: AztecAddress): Promise<void> {
		const key = this.#key(deployment, recipient)
		const entry = this.#live(key)
		if (!entry) throw required()
		const wanted = recipient.toString().toLowerCase()
		const listed = (await entry.wallet.getAccounts()).some((a) => a.item.toString().toLowerCase() === wanted)
		if (!listed || this.#live(key) !== entry) throw required()
		this.#entries.delete(key)
	}
}
