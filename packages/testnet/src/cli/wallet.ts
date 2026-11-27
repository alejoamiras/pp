import { laggingTolerant, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { type JournalEntry, SendPath, sendThrough } from "@pp/pp-env/send-path"
import { type Address, createWalletClient, type Hex, http, isAddressEqual } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { GuardError } from "../guards"
import type { TestnetDeployment } from "../schema"

/** The file's send endpoint; a rehearsal file without one sends where it reads. */
export const sendRpcOf = (d: TestnetDeployment): string => d.network.l1SendRpc ?? d.network.l1Rpc

/** A read transport over `url` with redirects refused, outlasting a lagging backend at the public chain's polling interval. */
export const l1Read = (url: string) =>
	laggingTolerant(http(url, { fetchOptions: { redirect: "error" } }), PUBLIC_CHAIN_TIMING.pollingIntervalMs)

/** A send path from `senders` over the file's two endpoints. */
export const sendPathOf = (d: TestnetDeployment, senders: readonly Address[], journal?: (e: JournalEntry) => void) =>
	new SendPath({
		readUrl: d.network.l1Rpc,
		sendUrl: sendRpcOf(d),
		chainId: d.network.l1ChainId,
		senders,
		...(journal && { journal }),
	})

/**
 * An L1 wallet for `key` that reads from the file's endpoint and sends through a {@link SendPath} to its
 * send endpoint, refused unless its address is `want`. The path is returned so a caller can wait for a
 * send to show on the read endpoint.
 * @throws GuardError `account` naming the role, never the key
 */
export function l1Sender(d: TestnetDeployment, key: Hex, role: string, want?: Address, journal?: (e: JournalEntry) => void) {
	const account = privateKeyToAccount(key)
	if (want && !isAddressEqual(account.address, want))
		throw new GuardError("account", `the ${role} key is for ${account.address}, the file expects ${want}`)
	const path = sendPathOf(d, [account.address], journal)
	const wallet = createWalletClient({
		account,
		chain: {
			id: d.network.l1ChainId,
			name: `chain ${d.network.l1ChainId}`,
			nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [d.network.l1Rpc] } },
		},
		transport: sendThrough(l1Read(d.network.l1Rpc), path),
	})
	return { wallet, path }
}

/** {@link l1Sender}'s wallet alone. */
export const l1Wallet = (d: TestnetDeployment, key: Hex, role: string, want?: Address, journal?: (e: JournalEntry) => void) =>
	l1Sender(d, key, role, want, journal).wallet
