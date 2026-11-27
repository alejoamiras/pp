/**
 * A deny-by-default EIP-1193 wrapper for the wallet client that sends a bridge spend: every send or
 * sign method runs `assertCurrent` first, allow-listed reads pass, and anything else is refused.
 * `wallet_sendTransaction` counts as a send because viem 2.57.1 falls back to it when a provider
 * answers `eth_sendTransaction` with -32601 or similar.
 */
import { ProviderError } from "../errors"

export interface Eip1193Provider {
	request(args: { method: string; params?: unknown }): Promise<unknown>
}

const SEND_OR_SIGN: ReadonlySet<string> = new Set([
	"eth_sendTransaction",
	"wallet_sendTransaction",
	"eth_sendRawTransaction",
	"wallet_sendCalls",
	"eth_signTransaction",
	"eth_sign",
	"personal_sign",
])

/** What viem's simulate, estimate, write and receipt paths read. */
const READS: ReadonlySet<string> = new Set([
	"eth_accounts",
	"eth_blockNumber",
	"eth_call",
	"eth_chainId",
	"eth_estimateGas",
	"eth_feeHistory",
	"eth_gasPrice",
	"eth_getBalance",
	"eth_getBlockByHash",
	"eth_getBlockByNumber",
	"eth_getCode",
	"eth_getLogs",
	"eth_getStorageAt",
	"eth_getTransactionByHash",
	"eth_getTransactionCount",
	"eth_getTransactionReceipt",
	"eth_maxPriorityFeePerGas",
	"net_version",
])

export const isSendOrSign = (method: string): boolean => SEND_OR_SIGN.has(method) || method.startsWith("eth_signTypedData")

/**
 * A refusal at the handoff is a definitive no before broadcast (4001), so a caller that keeps a journal
 * restores its record; a method off the list is unsupported (4200).
 */
export function guardedProvider(inner: Eip1193Provider, assertCurrent: () => void): Eip1193Provider {
	return {
		async request(args) {
			// Read once: a getter could answer the check with one method and the forward with another.
			const method = String(args.method)
			const forward = { method, params: args.params }
			if (isSendOrSign(method)) {
				try {
					assertCurrent()
				} catch {
					throw new ProviderError(4001, "The wallet context changed; nothing was sent.", { reason: "context-changed" })
				}
				return inner.request(forward)
			}
			if (READS.has(method)) return inner.request(forward)
			throw new ProviderError(4200, `${method} is not allowed here.`, { reason: "method-not-allowed" })
		},
	}
}
