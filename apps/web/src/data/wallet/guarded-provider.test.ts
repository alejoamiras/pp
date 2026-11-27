import { createWalletClient, custom, defineChain } from "viem"
import { describe, expect, test, vi } from "vitest"
import { isWalletRefusal, providerCode } from "../errors"
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
		for (const method of SEND_AND_SIGN) {
			const guarded = guardedProvider(wallet, () => {
				throw new Error("changed")
			})
			await expect(guarded.request({ method, params: [] }), method).rejects.toMatchObject({ code: 4001 })
		}
		expect(seen).toEqual([])
	})

	const send = (guarded: Eip1193Provider) =>
		createWalletClient({ account: SENDER, chain, transport: custom(guarded) })
			.sendTransaction({ to: SENDER, value: 0n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 })
			.catch((e: unknown) => e)

	/** A wallet that answers every send with the error `code`, after which it may or may not have broadcast. */
	function failing(code: number) {
		const seen: string[] = []
		const wallet: Eip1193Provider = {
			async request({ method }) {
				seen.push(method)
				if (method === "eth_chainId") return "0x7a69"
				throw Object.assign(new Error("failed"), { code })
			},
		}
		return { wallet, sends: () => seen.filter((m) => m !== "eth_chainId") }
	}

	test.each([-32000, -32602])(
		"asks the wallet once: viem's wallet_sendTransaction retry after eth_sendTransaction's %i reaches neither the wallet nor the handoff, and reads as possibly sent",
		async (code) => {
			const assertCurrent = vi.fn()
			const { wallet, sends } = failing(code)
			const err = await send(guardedProvider(wallet, assertCurrent))
			expect(sends()).toEqual(["eth_sendTransaction"])
			expect(assertCurrent).toHaveBeenCalledTimes(1)
			expect(isWalletRefusal(err)).toBe(false)
			expect(providerCode(err)).toBe(4100)
		},
	)

	test.each([-32601, -32004])(
		"lets viem's retry through once after a wallet that lacks eth_sendTransaction (%i), running the handoff again",
		async (code) => {
			const assertCurrent = vi.fn()
			const { wallet, sends } = failing(code)
			await send(guardedProvider(wallet, assertCurrent))
			expect(sends()).toEqual(["eth_sendTransaction", "wallet_sendTransaction"])
			expect(assertCurrent).toHaveBeenCalledTimes(2)
			// A third request, whatever the second's answer, never reaches the wallet.
			const guarded = guardedProvider(wallet, assertCurrent)
			await guarded.request({ method: "eth_sendTransaction" }).catch(() => {})
			await guarded.request({ method: "wallet_sendTransaction" }).catch(() => {})
			await expect(guarded.request({ method: "wallet_sendTransaction" })).rejects.toMatchObject({ code: 4100 })
			expect(sends()).toHaveLength(4)
		},
	)

	test.each([null, "0x1234", { hash: `0x${"ab".repeat(32)}` }])(
		"reads a send the wallet answers with %j, not a transaction hash, as possibly sent",
		async (answer) => {
			const { wallet } = recordingWallet(() => answer)
			const err = await send(guardedProvider(wallet, () => {}))
			expect(isWalletRefusal(err)).toBe(false)
			expect(providerCode(err)).toBe(4100)
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
