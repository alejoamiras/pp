import { createPublicClient, createWalletClient, custom, type Hex, http, type Transport, type WalletClient } from "viem"

/**
 * An L1 transport over `url` that records every raw transaction and lets a case act on the way out:
 * `beforeSend` runs after the wallet signed and before the node sees the transaction, and `nonceGap`
 * makes the wallet sign one nonce ahead, so the node holds the transaction unmined until the gap fills.
 */
export function recordingTransport(url: string) {
	const sends: Hex[] = []
	const hooks: { beforeSend?: (raw: Hex) => Promise<void>; nonceGap?: boolean } = {}
	const transport: Transport = (args) => {
		const inner = http(url)({ ...args, retryCount: 0 })
		return custom({
			async request({ method, params }: { method: string; params?: unknown }) {
				if (method === "eth_getTransactionCount" && hooks.nonceGap) {
					const count = BigInt((await inner.request({ method, params } as never)) as Hex)
					return `0x${(count + 1n).toString(16)}`
				}
				// viem fills a local account's transaction through this one call when the node offers it.
				if (method === "eth_fillTransaction" && hooks.nonceGap) {
					const filled = (await inner.request({ method, params } as never)) as { tx: { nonce: Hex } }
					return { ...filled, tx: { ...filled.tx, nonce: `0x${(BigInt(filled.tx.nonce) + 1n).toString(16)}` } }
				}
				if (method === "eth_sendRawTransaction") {
					const raw = (params as Hex[])[0] as Hex
					sends.push(raw)
					await hooks.beforeSend?.(raw)
				}
				return inner.request({ method, params } as never)
			},
		})(args)
	}
	return { transport, sends, hooks }
}

/**
 * Sends `wallet`'s first unmined nonce as a zero-value self-transfer, mining whatever waited behind
 * the gap. The nonce is the mined count: a pending count could already include the queued transaction.
 */
export async function fillGap(wallet: WalletClient, url: string): Promise<Hex> {
	const account = wallet.account!
	const nonce = await createPublicClient({ transport: http(url) }).getTransactionCount({ address: account.address, blockTag: "latest" })
	const plain = createWalletClient({ account, chain: wallet.chain, transport: http(url) })
	return plain.sendTransaction({ to: account.address, value: 0n, nonce, chain: wallet.chain })
}
