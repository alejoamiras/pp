/**
 * The real Aztec wallet connector over the wallet SDK: node check, discovery, secure channel, emoji
 * confirmation, then a grant of accounts only. One run counter orders every flow: each `connect` and
 * `disconnect` advances it, and a continuation that wakes up under a newer run drops its result and
 * undoes the channel it opened itself, never one a newer run owns.
 */
import type { ChainInfo } from "@aztec-labs/aztec.js/account"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { hashToEmoji } from "@aztec-labs/wallet-sdk/crypto"
import { type PendingConnection, WalletManager, type WalletProvider } from "@aztec-labs/wallet-sdk/manager"
import type { PublicTarget } from "../../build/target"
import { sanitizeWalletName } from "./display"
import { connectManifest, grantedAccounts } from "./grant"
import { assertNodeServesTarget } from "./node-check"
import {
	type AztecConnection,
	type ConfirmEmoji,
	ConnectError,
	emojiMismatchError,
	supersededError,
	type WalletConnector,
	type WalletOption,
} from "./types"

/** The app id every wallet sees; the test wallet refuses any other. */
export const APP_ID = "pp"
const DISCOVERY_TIMEOUT_MS = 15_000
const EMOJI_CELLS = 9

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function emojiGrid(verificationHash: string): string[] {
	return Array.from(graphemes.segment(hashToEmoji(verificationHash, EMOJI_CELLS)), (s) => s.segment).slice(0, EMOJI_CELLS)
}

/** Wallet rejections arrive as plain errors whose wording is the wallet's; only the category is kept. */
function asConnectError(err: unknown): unknown {
	if (err instanceof ConnectError) return err
	const text = err instanceof Error ? err.message : String(err)
	if (/reject|denied|cancel/i.test(text))
		return new ConnectError("rejected", "The wallet declined the request. Try again when you are ready.")
	return err
}

export function createRealConnector(t: PublicTarget): WalletConnector {
	let run = 0
	let nextKey = 0
	const providers = new Map<number, WalletProvider>()
	/** The run that last opened a channel on each provider: only that run may tear it down. */
	const owner = new Map<WalletProvider, number>()
	let live: WalletProvider | null = null

	const chainInfo = (): ChainInfo => ({ chainId: new Fr(BigInt(t.l1ChainId)), version: new Fr(BigInt(t.rollupVersion)) })
	const assertCurrent = (mine: number) => {
		if (mine !== run) throw supersededError()
	}
	const release = async (provider: WalletProvider, mine: number) => {
		if (owner.get(provider) !== mine) return
		owner.delete(provider)
		if (live === provider) live = null
		await provider.disconnect().catch(() => {})
	}

	function admit(p: WalletProvider): WalletOption | null {
		// The SDK passes an announcement's claimed fields through unchecked, whatever its types say.
		const { id, name, type }: { id: unknown; name: unknown; type: unknown } = p
		if (typeof id !== "string" || typeof name !== "string") return null
		const option: WalletOption = {
			key: nextKey++,
			id,
			name: sanitizeWalletName(name) || "Unnamed wallet",
			kind: type === "web" ? "web" : "extension",
		}
		providers.set(option.key, p)
		return option
	}

	async function discover(onOption: (o: WalletOption) => void, signal: AbortSignal): Promise<void> {
		await assertNodeServesTarget(t, signal)
		providers.clear()
		const session = WalletManager.configure({
			extensions: { enabled: true },
			...(t.walletUrls.length > 0 ? { webWallets: { urls: [...t.walletUrls] } } : {}),
		}).getAvailableWallets({ chainInfo: chainInfo(), appId: APP_ID, timeout: DISCOVERY_TIMEOUT_MS })
		const stop = () => session.cancel()
		signal.addEventListener("abort", stop, { once: true })
		try {
			for await (const p of session.wallets) {
				// The SDK can yield buffered announcements after cancel.
				if (signal.aborted) return
				const option = admit(p)
				if (option) onOption(option)
			}
		} finally {
			signal.removeEventListener("abort", stop)
		}
	}

	async function verify(mine: number, pending: PendingConnection, confirm: ConfirmEmoji): Promise<void> {
		try {
			assertCurrent(mine)
			const matches = await confirm(emojiGrid(pending.verificationHash))
			assertCurrent(mine)
			if (!matches) throw emojiMismatchError()
		} catch (err) {
			pending.cancel()
			throw err
		}
	}

	async function grant(mine: number, provider: WalletProvider, wallet: Wallet, option: WalletOption): Promise<AztecConnection> {
		try {
			assertCurrent(mine)
			const answer: unknown = await wallet.requestCapabilities(connectManifest())
			assertCurrent(mine)
			const accounts = grantedAccounts(answer)
			if (accounts.length === 0)
				throw new ConnectError("no-accounts", "The wallet granted no account. Allow at least one, then try again.")
			live = provider
			return { epoch: mine, walletName: option.name, accounts }
		} catch (err) {
			await release(provider, mine)
			throw asConnectError(err)
		}
	}

	async function openChannel(mine: number, provider: WalletProvider, confirm: ConfirmEmoji): Promise<Wallet> {
		owner.set(provider, mine)
		try {
			const pending = await provider.establishSecureChannel(APP_ID)
			await verify(mine, pending, confirm)
			return await pending.confirm()
		} catch (err) {
			await release(provider, mine)
			throw asConnectError(err)
		}
	}

	const releaseLive = async () => {
		const current = live
		if (current) await release(current, owner.get(current) ?? Number.NaN)
	}

	async function connect(option: WalletOption, confirm: ConfirmEmoji): Promise<AztecConnection> {
		const mine = ++run
		await releaseLive()
		const provider = providers.get(option.key)
		if (!provider) throw new ConnectError("no-wallet", "That wallet is no longer available. Search again.")
		const wallet = await openChannel(mine, provider, confirm)
		return grant(mine, provider, wallet, option)
	}

	async function disconnect(): Promise<void> {
		run++
		await releaseLive()
	}

	return { discover, connect, disconnect }
}
