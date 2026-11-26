/**
 * The fixture Ethereum wallet: two accounts (the pool owner, who signs in, and a separate sender), one
 * selected at a time, and an EIP-1193 provider that accepts sends only from the selected account on
 * the world's chain.
 */
import { type Address, isAddressEqual } from "viem"
import { ProviderError } from "../errors"
import type { L1Port } from "../ports"
import type { Eip1193Provider } from "../wallet/guarded-provider"
import { ACCOUNTS } from "./seed"
import type { World } from "./world"

export const FAKE_SIGNATURE = `0x${"5a".repeat(65)}` as const

export const selectedAccount = (w: World): Address => ACCOUNTS[w.s.selected]

export function fixtureL1(w: World): L1Port & { provider: Eip1193Provider } {
	const send = async (params: unknown): Promise<`0x${string}`> => {
		const from = (Array.isArray(params) ? (params[0] as { from?: unknown } | undefined)?.from : undefined) as Address | undefined
		if (typeof from !== "string" || !isAddressEqual(from, selectedAccount(w))) throw new ProviderError(4100, "not the selected account")
		const hash = w.nextHex(32)
		w.update((s) => {
			s.sent.l1++
		})
		return hash
	}
	const provider: Eip1193Provider = {
		async request({ method, params }) {
			if (method === "eth_chainId") return `0x${w.s.walletChain.toString(16)}`
			if (method === "eth_accounts") return [selectedAccount(w)]
			if (method === "eth_sendTransaction" || method === "wallet_sendTransaction") return send(params)
			throw new ProviderError(4200, `${method} is not supported by the fixture wallet`)
		},
	}
	const watch = <T>(read: () => T, f: (v: T) => void) => {
		let last = read()
		return w.subscribe(() => {
			const next = read()
			if (next !== last) {
				last = next
				f(next)
			}
		})
	}
	return {
		provider,
		accounts: async () => [selectedAccount(w)],
		chainId: async () => w.s.walletChain,
		async signTypedData(owner) {
			if (!isAddressEqual(owner, selectedAccount(w))) throw new ProviderError(4100, "not the selected account")
			return FAKE_SIGNATURE
		},
		onAccountsChanged: (f) =>
			watch(
				() => selectedAccount(w),
				(a) => f([a]),
			),
		onChainChanged: (f) => watch(() => w.s.walletChain, f),
	}
}
