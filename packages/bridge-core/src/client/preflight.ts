import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { guarded } from "./boundary"
import { BridgeClientError } from "./errors"
import { sponsored, sponsoredFpcAddress } from "./payload"

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

/** The wallet surface preflight uses: its network, its accounts, and a simulation from one of them. */
export type PreflightWallet = Pick<Wallet, "getChainInfo" | "getAccounts" | "simulateTx">

/** The node surface preflight uses: public storage, where the FPC's Fee Juice balance lives. */
export type PreflightNode = Pick<AztecNode, "getPublicStorageAt">

/**
 * Checks that `recipient` can claim: a valid address, a wallet on the deployment's network, one of
 * that wallet's own accounts (only the recipient's account can claim), a SponsoredFPC holding Fee
 * Juice, and an empty transaction from it, paid by that FPC, simulating. The wallet simulates with a
 * stub account, so this tests the fee path, not the account's deployment. The FPC is probed by its
 * balance: a network's genesis FPC is never published as an instance, so the node serves none for it.
 * On success `preflights` keeps the wallet for this deployment and recipient for ten minutes.
 * @throws BridgeClientError `RECIPIENT_INVALID`, `CHAIN_MISMATCH`, `RECIPIENT_NOT_IN_WALLET`, `FEE_PATH_FAILED`
 */
export function preflight(
	ctx: { deployment: { id: string; chainId: number; rollupVersion: bigint }; node: PreflightNode; preflights: Preflights },
	a: { recipient: AztecAddress; wallet: PreflightWallet },
): Promise<void> {
	return guarded(async () => {
		const recipient = AztecAddress.fromStringUnsafe(String(a.recipient.toString()))
		const wallet = a.wallet
		const { id, chainId, rollupVersion } = ctx.deployment
		if (!(await recipient.isValid())) throw new BridgeClientError("RECIPIENT_INVALID")
		const network = await wallet.getChainInfo()
		if (network.chainId.toBigInt() !== BigInt(chainId) || network.version.toBigInt() !== rollupVersion)
			throw new BridgeClientError("CHAIN_MISMATCH")
		const wanted = recipient.toString().toLowerCase()
		if (!(await wallet.getAccounts()).some((x) => x.item.toString().toLowerCase() === wanted))
			throw new BridgeClientError("RECIPIENT_NOT_IN_WALLET")
		if ((await getFeeJuiceBalance(await sponsoredFpcAddress(), ctx.node as AztecNode)) === 0n)
			throw new BridgeClientError("FEE_PATH_FAILED")
		const empty = await sponsored(new ExecutionPayload([], [], []))
		await wallet.simulateTx(empty, { from: recipient }).catch(() => {
			throw new BridgeClientError("FEE_PATH_FAILED")
		})
		ctx.preflights.record(id, recipient, wallet)
	})
}
