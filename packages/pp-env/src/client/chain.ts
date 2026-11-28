import { createPublicClient, defineChain, http, type PublicClient } from "viem"
import type { ClientConfig } from "./types.ts"

/**
 * The read client for `config`'s node, fetched with redirects refused. Its chain lists that node as its
 * only RPC URL: a bare `http()` on a stock chain object (Sepolia's, say) falls back to a public endpoint,
 * which a fork must never reach.
 */
export function publicClientAt(config: Pick<ClientConfig, "chainId" | "rpcUrl">): PublicClient {
	const chain = defineChain({
		id: config.chainId,
		name: `chain-${config.chainId}`,
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [config.rpcUrl] } },
	})
	// CCIP-read off: a contract another party controls must not answer a read with a URL to fetch.
	return createPublicClient({
		chain,
		transport: http(config.rpcUrl, { fetchOptions: { redirect: "error" } }),
		pollingInterval: 100,
		ccipRead: false,
	})
}
