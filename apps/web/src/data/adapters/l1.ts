/**
 * Ethereum for a stack build: reads over the target's RPC, signatures and sends through the page's
 * injected wallet (EIP-1193). A bridge spend's or a settle's wallet client is pinned to its sender and
 * the target's chain (viem checks the wallet's chain right before it sends) over the deny-by-default guard.
 */
import {
	type Account,
	type Address,
	type Chain,
	createPublicClient,
	createWalletClient,
	custom,
	defineChain,
	getAddress,
	type Hash,
	http,
	isAddress,
	isAddressEqual,
	isHash,
	type PublicClient,
	type TypedDataDefinition,
	type Transport,
	type WalletClient,
} from "viem"
import type { PublicTarget } from "../../build/target"
import { chainName } from "../chain"
import { BridgeFailure } from "../errors"
import type { Attempt, L1Port, SubmitHooks } from "../ports"
import { type Eip1193Provider, guardedProvider } from "../wallet/guarded-provider"

/** A browser wallet: requests plus the two events the page follows. */
export interface InjectedWallet extends Eip1193Provider {
	on?(event: string, listener: (value: unknown) => void): unknown
	removeListener?(event: string, listener: (value: unknown) => void): unknown
}

export function targetChain(t: Pick<PublicTarget, "l1ChainId" | "l1RpcUrl">): Chain {
	return defineChain({
		id: t.l1ChainId,
		name: chainName(t.l1ChainId),
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [t.l1RpcUrl] } },
	})
}

const SENDS: ReadonlySet<string> = new Set(["eth_sendTransaction", "wallet_sendTransaction"])

/** Calls `sent` with the hash a send method returns, before the caller sees it; any other answer passes untouched. */
export function reportSends(inner: Eip1193Provider, sent: (txHash: Hash) => void): Eip1193Provider {
	return {
		async request(args) {
			const method = String(args.method)
			const result = await inner.request({ method, params: args.params })
			if (SENDS.has(method) && typeof result === "string" && isHash(result)) sent(result)
			return result
		},
	}
}

/** Accounts as the wallet lists them; anything that is not an address is dropped. */
const addressesOf = (value: unknown): Address[] =>
	Array.isArray(value) ? value.filter((a): a is string => typeof a === "string" && isAddress(a)).map((a) => getAddress(a)) : []

/**
 * The local demo's dev account, which anvil signs for: a bridge can send from a separate address with
 * no second wallet. Its provider sits behind the same guard as a wallet's.
 */
export interface DemoSender {
	readonly address: Address
	/** Resolves once the node serves the target's chain and the portal has code; the provider sends nothing before. */
	ready(): Promise<void>
	readonly provider: Eip1193Provider
}

export interface StackL1 extends L1Port {
	readonly reads: PublicClient
	/**
	 * The client a bridge spend sends through: the demo sender's provider for an attempt made under the
	 * page's choice of it, else the injected wallet. `assertCurrent` runs before every send or sign, and
	 * `hooks.sent` hears the hash.
	 */
	spendWallet(a: Attempt, assertCurrent: () => void, hooks: Pick<SubmitHooks, "sent">): WalletClient<Transport, Chain, Account>
	/** The client a settle sends through, chosen as for a spend, pinned to `from.sender` and the target's chain, behind the same guard. */
	settleWallet(from: Pick<Attempt, "sender" | "demo">, assertCurrent: () => void): WalletClient<Transport, Chain, Account>
}

export function stackL1(
	t: Pick<PublicTarget, "l1ChainId" | "l1RpcUrl">,
	wallet: InjectedWallet | undefined,
	demo: DemoSender | null = null,
): StackL1 {
	const chain = targetChain(t)
	const reads = createPublicClient({ chain, transport: http(t.l1RpcUrl) })
	const need = (): InjectedWallet => {
		if (!wallet) throw new BridgeFailure("NO_SENDER")
		return wallet
	}
	// A wallet may hold the dev account too; only the page's own choice routes a send to the demo sender.
	const senderOf = (from: Pick<Attempt, "sender" | "demo">): Eip1193Provider =>
		from.demo && demo && isAddressEqual(from.sender, demo.address) ? demo.provider : need()
	const follow = (event: string, f: (value: unknown) => void) => {
		wallet?.on?.(event, f)
		return () => void wallet?.removeListener?.(event, f)
	}
	return {
		reads,
		accounts: async () => (wallet ? addressesOf(await wallet.request({ method: "eth_accounts" })) : []),
		chainId: async () => Number(await need().request({ method: "eth_chainId" })),
		signTypedData(owner, td) {
			const client = createWalletClient({ transport: custom(need()) })
			return client.signTypedData({ account: owner, ...(td as TypedDataDefinition) })
		},
		onAccountsChanged: (f) => follow("accountsChanged", (v) => f(addressesOf(v))),
		onChainChanged: (f) => follow("chainChanged", (v) => f(Number(v))),
		...(demo ? { demo: { address: demo.address, ready: () => demo.ready() } } : {}),
		spendWallet(a, assertCurrent, hooks) {
			return createWalletClient({
				account: a.sender,
				chain,
				transport: custom(reportSends(guardedProvider(senderOf(a), assertCurrent), hooks.sent)),
			})
		},
		settleWallet: (from, assertCurrent) =>
			createWalletClient({ account: from.sender, chain, transport: custom(guardedProvider(senderOf(from), assertCurrent)) }),
	}
}
