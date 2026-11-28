import { expect, test } from "bun:test"
import type { ForkAnvil } from "./anvil.ts"
import type { Rpc } from "./rpc.ts"
import { assertFork, forkReader } from "./writer.ts"

const node =
	(version: string, chainId: string): Rpc =>
	async <T>(method: string) =>
		(method === "web3_clientVersion" ? version : chainId) as T

test("writers refuse any node but the pinned anvil on Sepolia's chain id", async () => {
	await assertFork(node("anvil/v1.7.1", "0xaa36a7"))
	await expect(assertFork(node("anvil/v1.8.5", "0xaa36a7"))).rejects.toThrow("expected exactly anvil/v1.7.1")
	await expect(assertFork(node("Geth/v1.14.0", "0xaa36a7"))).rejects.toThrow("refusing to write to Geth")
	await expect(assertFork(node("anvil/v1.7.1", "0x1"))).rejects.toThrow("refusing to write to chain 1")
})

test("a fork client names the fork in its transport and as its chain's only RPC URL", () => {
	const url = "http://127.0.0.1:4321"
	const client = forkReader({ url } as ForkAnvil)
	expect(client.transport.url).toBe(url)
	expect(client.chain?.id).toBe(11_155_111)
	expect(client.chain?.rpcUrls).toEqual({ default: { http: [url] } })
	expect(client.ccipRead).toBe(false)
})
