/**
 * A deny-by-default EIP-1193 wrapper for the wallet client of one send: the first send or sign method
 * runs `assertCurrent` first, allow-listed reads pass, and anything else is refused.
 * `wallet_sendTransaction` counts as a send because viem 2.57.1 falls back to it, with the same
 * calldata, when a provider answers `eth_sendTransaction` with -32000, -32601, -32602 or -32004.
 */
import { isHash } from "viem"
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

const TX_SENDS: ReadonlySet<string> = new Set(["eth_sendTransaction", "wallet_sendTransaction", "eth_sendRawTransaction"])

/** The wallet does not have the method, so it did nothing; trusted as its own 4001 is. */
const UNSUPPORTED: ReadonlySet<unknown> = new Set([-32601, -32004])

/** Past the handoff, so never a 4001: every caller reads a 4001 as proof that nothing went out. */
const mayHaveSent = (message: string, reason: string) => new ProviderError(4100, message, { reason })

/**
 * A refusal at the handoff is a definitive no before broadcast (4001), so a caller that keeps a journal
 * restores its record; a method off the list is unsupported (4200). One send or sign request reaches
 * the wallet, and one more only after the wallet answered the first that it lacks the method (viem's
 * retry, which runs the handoff again). Any other second request (viem also retries after -32000 and
 * -32602, which may follow a broadcast) is refused without reaching it, and like a send answered with
 * anything but a transaction hash, reads as one that may have gone out (4100).
 */
export function guardedProvider(inner: Eip1193Provider, assertCurrent: () => void): Eip1193Provider {
	let left = 1
	let retried = false
	return {
		async request(args) {
			// Read once: a getter could answer the check with one method and the forward with another.
			const method = String(args.method)
			const forward = { method, params: args.params }
			if (isSendOrSign(method)) {
				if (left === 0) throw mayHaveSent("This send was already asked of the wallet; it may have gone out.", "second-send")
				left--
				try {
					assertCurrent()
				} catch {
					throw new ProviderError(4001, "The wallet context changed; nothing was sent.", { reason: "context-changed" })
				}
				const answer = await inner.request(forward).catch((err: unknown) => {
					if (!retried && UNSUPPORTED.has((err as { code?: unknown } | null)?.code)) [left, retried] = [1, true]
					throw err
				})
				if (TX_SENDS.has(method) && !(typeof answer === "string" && isHash(answer)))
					throw mayHaveSent("The wallet answered the send without a transaction hash; it may have gone out.", "no-hash")
				return answer
			}
			if (READS.has(method)) return inner.request(forward)
			throw new ProviderError(4200, `${method} is not allowed here.`, { reason: "method-not-allowed" })
		},
	}
}
