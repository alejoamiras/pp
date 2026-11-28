import {
	type Account,
	type Address,
	type Chain,
	createPublicClient,
	createWalletClient,
	defineChain,
	type Hex,
	http,
	numberToHex,
	type PublicClient,
	type Transport,
	type WalletClient,
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { ANVIL_CLIENT_VERSION, type ForkAnvil } from "./anvil.ts"
import { SEPOLIA_CHAIN_ID } from "./pins.ts"
import type { Rpc } from "./rpc.ts"

export type ForkWallet = WalletClient<Transport, Chain, Account>

/**
 * Sepolia as served by the fork alone. A client given a stock chain object and a bare `http()` falls back
 * to that chain's public RPC; with this one, even a fallback reaches only the fork.
 */
export function forkChain(url: string): Chain {
	return defineChain({
		id: SEPOLIA_CHAIN_ID,
		name: "Sepolia fork",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [url] } },
	})
}

/**
 * Refuses any node but the fork: the exact anvil version this suite spawns, on Sepolia's chain id.
 * Writes then sign with keys that hold nothing on the live chain, so a replay there moves nothing.
 */
export async function assertFork(rpc: Rpc): Promise<void> {
	const version = await rpc<string>("web3_clientVersion")
	if (version !== ANVIL_CLIENT_VERSION) throw new Error(`refusing to write to ${version}: expected exactly ${ANVIL_CLIENT_VERSION}`)
	const chainId = Number(await rpc<Hex>("eth_chainId"))
	if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`refusing to write to chain ${chainId}: expected ${SEPOLIA_CHAIN_ID}`)
}

async function live(fork: ForkAnvil): Promise<void> {
	if (fork.owned.hasExited()) throw new Error(`refusing to write: the fork has exited (${fork.owned.exitReason()})`)
	await assertFork(fork.rpc)
}

// CCIP-read is off on every client here: the fork holds copies of the operator's contracts, and an
// `OffchainLookup` revert from one would otherwise send the client to a URL of the operator's choosing.
export function forkReader(fork: ForkAnvil): PublicClient {
	return createPublicClient({ chain: forkChain(fork.url), transport: http(fork.url), ccipRead: false })
}

/** A wallet on a fresh random key, funded on the fork. */
export async function freshWriter(fork: ForkAnvil, balance = 10n ** 20n): Promise<ForkWallet> {
	await live(fork)
	const account = privateKeyToAccount(generatePrivateKey())
	await fork.rpc("anvil_setBalance", [account.address, numberToHex(balance)])
	return createWalletClient({ account, chain: forkChain(fork.url), transport: http(fork.url), ccipRead: false })
}

/** A wallet that sends as `address` through anvil's impersonation, which only a fork honours. */
export async function impersonatedWriter(fork: ForkAnvil, address: Address, balance = 10n ** 20n): Promise<ForkWallet> {
	await live(fork)
	await fork.rpc("anvil_impersonateAccount", [address])
	await fork.rpc("anvil_setBalance", [address, numberToHex(balance)])
	return createWalletClient({ account: address, chain: forkChain(fork.url), transport: http(fork.url), ccipRead: false })
}
