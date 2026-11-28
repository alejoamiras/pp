import { type Account, createPublicClient, createWalletClient, http, type PublicClient } from "viem"
import { type JournalEntry, SendPath, sendThrough } from "../send-path.ts"
import { assertSepolia, SEPOLIA, sepolia } from "./chain.ts"

export { journalTo } from "../send-log.ts"

/** Reads with redirects refused, as every send-path endpoint is fetched. */
export const readTransport = (rpcUrl: string) => http(rpcUrl, { fetchOptions: { redirect: "error" } })

/** A reader over {@link readTransport} with CCIP-read off, so no contract it calls can answer with a URL to fetch. */
export const readClient = (rpcUrl: string) => createPublicClient({ transport: readTransport(rpcUrl), ccipRead: false })

/**
 * A public client over `rpcUrl`, once both endpoints are seen serving chain 11155111.
 * @throws Error naming the chain an endpoint serves
 */
export async function sepoliaClients(o: { rpcUrl: string; sendRpcUrl: string; chainId: number }): Promise<PublicClient> {
	const client = readClient(o.rpcUrl)
	await assertSepolia(client, o.chainId)
	await assertSepolia(readClient(o.sendRpcUrl), o.chainId)
	return client
}

/**
 * A wallet for `account` that reads from `rpcUrl` and sends through a {@link SendPath} to `sendRpcUrl`,
 * from `account` alone. Close the path when the wallet is done.
 */
export function sepoliaWallet(o: { account: Account; rpcUrl: string; sendRpcUrl: string; journal?: (e: JournalEntry) => void }) {
	const path = new SendPath({
		readUrl: o.rpcUrl,
		sendUrl: o.sendRpcUrl,
		chainId: SEPOLIA,
		senders: [o.account.address],
		...(o.journal && { journal: o.journal }),
	})
	const chain = { ...sepolia, rpcUrls: { default: { http: [o.rpcUrl] } } }
	const wallet = createWalletClient({
		account: o.account,
		chain,
		transport: sendThrough(readTransport(o.rpcUrl), path),
		ccipRead: false,
	})
	return { wallet, path }
}
