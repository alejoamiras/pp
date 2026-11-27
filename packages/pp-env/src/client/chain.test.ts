import { expect, test } from "bun:test"
import { publicClientAt } from "./chain.ts"

test("the read client names the configured node in both its transport and its chain", () => {
	const rpcUrl = "http://127.0.0.1:4321"
	const client = publicClientAt({ chainId: 11_155_111, rpcUrl })
	expect(client.transport.url).toBe(rpcUrl)
	expect(client.chain?.id).toBe(11_155_111)
	expect(client.chain?.rpcUrls).toEqual({ default: { http: [rpcUrl] } })
})
