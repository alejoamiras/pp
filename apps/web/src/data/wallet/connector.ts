/**
 * The real Aztec wallet connector over the wallet SDK: node check, discovery, secure channel, emoji
 * confirmation, then the stage's capability request. One run counter orders every flow: each
 * `connect`, `disconnect` and remote disconnect advances it, and a continuation that wakes up under a
 * newer run drops its result and undoes the channel it opened itself, never one a newer run owns.
 */
import type { ChainInfo } from "@aztec-labs/aztec.js/account"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AppCapabilities, Wallet } from "@aztec-labs/aztec.js/wallet"
import { hashToEmoji } from "@aztec-labs/wallet-sdk/crypto"
import { type PendingConnection, WalletManager, type WalletProvider } from "@aztec-labs/wallet-sdk/manager"
import type { PublicTarget } from "../../build/target"
import type { FunctionScope, Manifest } from "../capabilities"
import { isUserRejection, providerCode } from "../errors"
import type { WalletPort } from "../ports"
import { sanitizeWalletIcon, sanitizeWalletName } from "./display"
import { parseGrant } from "./grant"
import { assertNodeServesTarget } from "./node-check"
import {
	type AztecConnection,
	type ConfirmEmoji,
	ConnectError,
	emojiMismatchError,
	type Grant,
	noAccountsError,
	supersededError,
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

/** The live connection's wallet handle, for the stack adapters only: screens see `AztecConnection`. */
export interface HeldWallet {
	readonly epoch: number
	readonly wallet: Wallet
	readonly grant: Grant
}

export interface RealConnector extends WalletPort {
	/** The live connection's wallet; `null` from the moment a newer connect, a disconnect or a remote disconnect starts. */
	current(): HeldWallet | null
}

/** The SDK's discovery, narrowed to what the connector uses; tests pass their own. */
export type Discover = (t: PublicTarget, chainInfo: ChainInfo) => { wallets: AsyncIterable<WalletProvider>; cancel(): void }

const sdkDiscover: Discover = (t, chainInfo) =>
	WalletManager.configure({
		extensions: { enabled: true },
		...(t.walletUrls.length > 0 ? { webWallets: { urls: [...t.walletUrls] } } : {}),
	}).getAvailableWallets({ chainInfo, appId: APP_ID, timeout: DISCOVERY_TIMEOUT_MS })

const CAPABILITY_DENIED = /capabilit\w* (?:denied|rejected)/i

/** A wallet's failure as one of the categories the page has words for; its own wording is dropped. */
export function asConnectError(err: unknown): unknown {
	if (err instanceof ConnectError) return err
	const text = err instanceof Error ? err.message : ""
	if (CAPABILITY_DENIED.test(text))
		return new ConnectError("denied", "You declined the permissions, so nothing was connected. Try again to allow them.")
	if (isUserRejection(err)) return new ConnectError("rejected", "The wallet declined the request. Try again when you are ready.")
	const code = providerCode(err)
	if (code === 4100) return new ConnectError("unauthorized", "The wallet has not authorized this app. Unlock it, then try again.")
	if (code === 4900 || code === 4901) return new ConnectError("disconnected", "The wallet disconnected. Open it, then try again.")
	return err
}

const scopes = (list: FunctionScope[]) => list.map((s) => ({ contract: AztecAddress.fromStringUnsafe(s.contract), function: s.function }))

/** The same request with the SDK's address class in place of the hex the app carries. */
export function toSdkManifest(m: Manifest): AppCapabilities {
	const [accounts, contracts, simulation, transaction] = m.capabilities
	return {
		version: m.version,
		metadata: { ...m.metadata },
		capabilities: [
			{ ...accounts },
			{ ...contracts, contracts: contracts.contracts.map((c) => AztecAddress.fromStringUnsafe(c)) },
			{
				type: "simulation",
				transactions: { scope: scopes(simulation.transactions.scope) },
				utilities: { scope: scopes(simulation.utilities.scope) },
			},
			{ type: "transaction", scope: scopes(transaction.scope) },
		],
	}
}

/** Discovery, the run counter and channel ownership; `connect` and the grant live in `createRealConnector`. */
function connectorState(t: PublicTarget, discover: Discover) {
	const s = {
		run: 0,
		nextKey: 0,
		providers: new Map<number, WalletProvider>(),
		/** The run that last opened a channel on each provider: only that run may tear it down. */
		owner: new Map<WalletProvider, number>(),
		unsubscribe: new Map<WalletProvider, () => void>(),
		live: null as WalletProvider | null,
		held: null as HeldWallet | null,
		listeners: new Set<() => void>(),
		assertCurrent(mine: number) {
			if (mine !== s.run) throw supersededError()
		},
		async release(provider: WalletProvider, mine: number) {
			if (s.owner.get(provider) !== mine) return
			s.owner.delete(provider)
			s.unsubscribe.get(provider)?.()
			s.unsubscribe.delete(provider)
			if (s.live === provider) s.drop()
			await provider.disconnect().catch(() => {})
		},
		drop() {
			s.live = null
			s.held = null
		},
		async releaseLive() {
			const current = s.live
			if (current) await s.release(current, s.owner.get(current) ?? Number.NaN)
		},
		admit(p: WalletProvider): WalletOption | null {
			// The SDK passes an announcement's claimed fields through unchecked, whatever its types say.
			const { id, name, type, icon }: { id: unknown; name: unknown; type: unknown; icon?: unknown } = p
			if (typeof id !== "string" || typeof name !== "string") return null
			const option: WalletOption = {
				key: s.nextKey++,
				id,
				name: sanitizeWalletName(name) || "Unnamed wallet",
				kind: type === "web" ? "web" : "extension",
				...(sanitizeWalletIcon(icon) ? { icon: sanitizeWalletIcon(icon) } : {}),
			}
			s.providers.set(option.key, p)
			return option
		},
		async discover(onOption: (o: WalletOption) => void, signal: AbortSignal): Promise<void> {
			const { rollupVersion } = await assertNodeServesTarget(t, signal)
			s.providers.clear()
			const chainInfo: ChainInfo = { chainId: new Fr(BigInt(t.l1ChainId)), version: new Fr(BigInt(rollupVersion)) }
			const session = discover(t, chainInfo)
			const stop = () => session.cancel()
			signal.addEventListener("abort", stop, { once: true })
			try {
				for await (const p of session.wallets) {
					// The SDK can yield buffered announcements after cancel.
					if (signal.aborted) return
					const option = s.admit(p)
					if (option) onOption(option)
				}
			} finally {
				signal.removeEventListener("abort", stop)
			}
		},
	}
	return s
}

export function createRealConnector(t: PublicTarget, manifest: Manifest, discover: Discover = sdkDiscover): RealConnector {
	const s = connectorState(t, discover)

	async function verify(mine: number, pending: PendingConnection, confirm: ConfirmEmoji): Promise<void> {
		try {
			s.assertCurrent(mine)
			const matches = await confirm(emojiGrid(pending.verificationHash))
			s.assertCurrent(mine)
			if (!matches) throw emojiMismatchError()
		} catch (err) {
			pending.cancel()
			throw err
		}
	}

	/** Subscribed after confirm: before the wallet exists the SDK hands back a no-op unsubscriber. */
	function watchDisconnect(mine: number, provider: WalletProvider): void {
		const off = provider.onDisconnect(() => {
			if (s.owner.get(provider) !== mine) return
			s.owner.delete(provider)
			s.unsubscribe.delete(provider)
			off()
			if (s.live === provider) s.drop()
			if (mine === s.run) s.run++
			for (const f of [...s.listeners]) f()
		})
		s.unsubscribe.set(provider, off)
	}

	async function openChannel(mine: number, provider: WalletProvider, confirm: ConfirmEmoji): Promise<Wallet> {
		s.owner.set(provider, mine)
		try {
			const pending = await provider.establishSecureChannel(APP_ID)
			await verify(mine, pending, confirm)
			const wallet = await pending.confirm()
			s.assertCurrent(mine)
			watchDisconnect(mine, provider)
			return wallet
		} catch (err) {
			await s.release(provider, mine)
			throw asConnectError(err)
		}
	}

	async function grant(mine: number, provider: WalletProvider, wallet: Wallet, option: WalletOption): Promise<AztecConnection> {
		try {
			s.assertCurrent(mine)
			const answer: unknown = await wallet.requestCapabilities(toSdkManifest(manifest))
			s.assertCurrent(mine)
			const granted = parseGrant(manifest, answer)
			if (granted.accounts.length === 0) throw noAccountsError()
			s.live = provider
			s.held = { epoch: mine, wallet, grant: granted }
			return { epoch: mine, walletName: option.name, accounts: granted.accounts, grant: granted }
		} catch (err) {
			await s.release(provider, mine)
			throw asConnectError(err)
		}
	}

	async function connect(option: WalletOption, confirm: ConfirmEmoji): Promise<AztecConnection> {
		const mine = ++s.run
		await s.releaseLive()
		const provider = s.providers.get(option.key)
		if (!provider) throw new ConnectError("no-wallet", "That wallet is no longer available. Search again.")
		const wallet = await openChannel(mine, provider, confirm)
		return grant(mine, provider, wallet, option)
	}

	return {
		discover: s.discover,
		connect,
		async disconnect() {
			s.run++
			await s.releaseLive()
		},
		onDisconnect(f) {
			s.listeners.add(f)
			return () => s.listeners.delete(f)
		},
		current: () => (s.held !== null && s.held.epoch === s.run ? s.held : null),
	}
}
