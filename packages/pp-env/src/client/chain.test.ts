import { expect, test } from "bun:test"
import { publicClientAt } from "./chain.ts"

test("the read client names the configured node in both its transport and its chain", () => {
	const rpcUrl = "http://127.0.0.1:4321"
	const client = publicClientAt({ chainId: 11_155_111, rpcUrl })
	expect(client.transport.url).toBe(rpcUrl)
	expect(client.chain?.id).toBe(11_155_111)
	expect(client.chain?.rpcUrls).toEqual({ default: { http: [rpcUrl] } })
})

test("the read client refuses a redirect instead of following it", async () => {
	let followed = false
	const target = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			followed = true
			return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" })
		},
	})
	const hop = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${target.port}`, 307) })
	try {
		const client = publicClientAt({ chainId: 11_155_111, rpcUrl: `http://127.0.0.1:${hop.port}` })
		await expect(client.getBlockNumber()).rejects.toThrow()
		expect(followed).toBe(false)
	} finally {
		hop.stop(true)
		target.stop(true)
	}
})
