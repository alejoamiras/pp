import { createWalletClient, custom, defineChain } from "viem"
import { describe, expect, test, vi } from "vitest"
import { type Eip1193Provider, guardedProvider } from "./guarded-provider"

const SENDER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const chain = defineChain({
	id: 31337,
	name: "local",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
})

/** A wallet that records what reaches it; `onSend` decides how it answers `eth_sendTransaction`. */
function recordingWallet(onSend: () => unknown = () => `0x${"ab".repeat(32)}`) {
	const seen: string[] = []
	const wallet: Eip1193Provider = {
		async request({ method }) {
			seen.push(method)
			if (method === "eth_chainId") return "0x7a69"
			if (method === "eth_sendTransaction") return onSend()
			return `0x${"cd".repeat(32)}`
		},
	}
	return { wallet, seen }
}

const SEND_AND_SIGN = [
	"eth_sendTransaction",
	"wallet_sendTransaction",
	"eth_sendRawTransaction",
	"wallet_sendCalls",
	"eth_signTransaction",
	"eth_sign",
	"personal_sign",
	"eth_signTypedData",
	"eth_signTypedData_v4",
]

describe("the guarded EIP-1193 wrapper", () => {
	test("forwards no send or sign method once the context changed, refusing each as a definitive no", async () => {
		const { wallet, seen } = recordingWallet()
		const guarded = guardedProvider(wallet, () => {
			throw new Error("changed")
		})
		for (const method of SEND_AND_SIGN) {
			await expect(guarded.request({ method, params: [] }), method).rejects.toMatchObject({ code: 4001 })
		}
		expect(seen).toEqual([])
	})

	test.each([4200, -32601])(
		"guards viem's wallet_sendTransaction fallback after the wallet answers eth_sendTransaction with %i",
		async (code) => {
			let current = true
			const assertCurrent = vi.fn(() => {
				if (!current) throw new Error("changed")
			})
			const { wallet, seen } = recordingWallet(() => {
				// The wallet refuses the first method; the context moves before any fallback.
				current = false
				throw Object.assign(new Error("unsupported"), { code })
			})
			const client = createWalletClient({ account: SENDER, chain, transport: custom(guardedProvider(wallet, assertCurrent)) })
			await expect(
				client.sendTransaction({ to: SENDER, value: 0n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 }),
			).rejects.toThrow()
			expect(seen.filter((m) => m !== "eth_chainId")).toEqual(["eth_sendTransaction"])
			// viem 2.57.1 retries with wallet_sendTransaction after -32601 only; the guard refused that retry.
			expect(assertCurrent).toHaveBeenCalledTimes(code === -32601 ? 2 : 1)
		},
	)

	test("refuses a method outside its allow-list and passes the reads viem needs", async () => {
		const { wallet, seen } = recordingWallet()
		const guarded = guardedProvider(wallet, () => {})
		for (const method of [
			"wallet_switchEthereumChain",
			"wallet_addEthereumChain",
			"eth_requestAccounts",
			"eth_subscribe",
			"wallet_grantPermissions",
		]) {
			await expect(guarded.request({ method }), method).rejects.toMatchObject({ code: 4200 })
		}
		expect(seen).toEqual([])
		for (const method of ["eth_chainId", "eth_call", "eth_estimateGas", "eth_getTransactionReceipt", "eth_getLogs"])
			await guarded.request({ method })
		expect(seen).toHaveLength(5)
	})
})
