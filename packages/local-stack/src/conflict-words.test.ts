// Ties the send path's conflict words to the guardian's pause, which reads them from a conflict's
// `data`. It lives here because this is the one package outside @pp/testnet that depends on both.
import { type GuardianL1, PauseError, pauseEntries } from "@pp/bridge-core/deploy"
import { CONFLICT_WORDS, SendPath, sendThrough } from "@pp/pp-env/send-path"
import { createWalletClient, type Hex, http, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import { afterEach, describe, expect, it, vi } from "vitest"

const READ = "http://read.test"
const SEND = "http://send.test"
const FACTORY = "0x00000000000000000000000000000000000000fa"
const BLOCK = { number: 11n, hash: `0x${"0b".repeat(32)}` as Hex }
/** anvil's first well-known account. */
const GUARDIAN = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
const FAST = { timing: { receiptTimeoutMs: 50, pollingIntervalMs: 1 }, waits: { stallMs: 20, finalityMs: 20 } }

/** Both endpoints: every send answered with `words`, no hash known, enough reads for viem to sign. */
function endpoints(words: string): void {
	vi.stubGlobal("fetch", async (_: unknown, init: { body: string }) => {
		const { id, method } = JSON.parse(init.body) as { id: number; method: string }
		const answer: Record<string, unknown> =
			method === "eth_sendRawTransaction"
				? { error: { code: -32000, message: words } }
				: method === "eth_getTransactionByHash"
					? { result: null }
					: method === "eth_chainId"
						? { result: toHex(sepolia.id) }
						: method === "eth_estimateGas"
							? { result: "0x5208" }
							: { error: { code: -32601, message: `${method} is not answered here` } }
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), { headers: { "content-type": "application/json" } })
	})
}

/** The guardian's L1: nonce 5 next, entries open, and the pause signed at 5 mined in a finalized block. */
function l1Of(mined: Set<Hex>): GuardianL1 {
	return {
		getChainId: async () => sepolia.id,
		estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
		getTransactionCount: async () => 5,
		readContract: async (q: { blockHash?: Hex }) => q.blockHash !== undefined,
		getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
			if (!mined.has(hash)) throw new Error(`Transaction receipt with hash "${hash}" could not be found.`)
			return { status: "success", blockNumber: BLOCK.number, blockHash: BLOCK.hash, transactionHash: hash }
		},
		getBlock: async () => BLOCK,
	} as unknown as GuardianL1
}

describe("a send path's conflict, through the guardian's pause", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	// Each word as the send path matches it: whole, in any case, among other words.
	it.each(CONFLICT_WORDS.flatMap((w) => [w, `${w.toUpperCase()}: next nonce 6, tx nonce 5`]))(
		"ends %j as an occupied nonce or a taken one, never unconfirmed",
		async (words) => {
			endpoints(words)
			const events: string[] = []
			const path = new SendPath({
				readUrl: READ,
				sendUrl: SEND,
				chainId: sepolia.id,
				senders: [GUARDIAN.address],
				journal: (e) => events.push(e.event),
			})
			const guardian = createWalletClient({ account: GUARDIAN, chain: sepolia, transport: sendThrough(http(READ), path) })
			const mined = new Set<Hex>()
			try {
				const outcome = await pauseEntries({ chainId: sepolia.id, l1: l1Of(mined), factory: FACTORY }, guardian, {
					...FAST,
					onSigned: (s) => mined.add(s.hash),
				}).then(
					(r) => `taken, then found its own pause at nonce ${r.nonce}`,
					(e: unknown) => (e instanceof PauseError ? `${e.code} at nonce ${e.nonce}` : e),
				)
				expect(events).toContain(`attempt 1: conflict (-32000 ${words})`)
				expect(["taken, then found its own pause at nonce 5", "PAUSE_NONCE_OCCUPIED at nonce 5"]).toContain(outcome)
			} finally {
				path.close()
			}
		},
	)
})
