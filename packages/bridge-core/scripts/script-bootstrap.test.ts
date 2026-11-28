import { type Transport, defineChain } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { createL1Clients } from "./script-bootstrap"

const chain = defineChain({
	id: 11155111,
	name: "t",
	nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
	rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
})
// Anvil's published dev key 0.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")

describe("createL1Clients", () => {
	it("routes only the wallet's requests through the wrapper, and leaves the public client plain", async () => {
		const seen: string[] = []
		let wrapped = 0
		const wrap = (t: Transport): Transport =>
			((args: Parameters<Transport>[0]) => {
				wrapped++
				const inner = t(args)
				return {
					...inner,
					request: async ({ method }: { method: string }) => {
						seen.push(method)
						return "0xaa36a7"
					},
				}
			}) as Transport
		const { wallet } = createL1Clients({ chain, rpcUrl: "http://127.0.0.1:1", account, wrapWalletTransport: wrap })
		expect(await wallet.request({ method: "eth_chainId" })).toBe("0xaa36a7")
		expect([wrapped, seen]).toEqual([1, ["eth_chainId"]])
	})
})
