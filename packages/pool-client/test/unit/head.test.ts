import { createPublicClient, custom, numberToHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { freshHead } from "../../src/client.ts"

describe("freshHead", () => {
	it("reads a head of its own while another head read is still in flight", async () => {
		let head = 5n
		let release: (() => void) | undefined
		let requests = 0
		// A real viem client, so its head cache and in-flight sharing are viem's own; only the node is scripted.
		const client = createPublicClient({
			transport: custom({
				async request({ method }) {
					if (method !== "eth_blockNumber") throw new Error(`unexpected ${method}`)
					const at = head
					if (++requests === 1) await new Promise<void>((r) => (release = r))
					return numberToHex(at)
				},
			}),
		})
		const held = client.getBlockNumber({ cacheTime: 0 })
		await vi.waitFor(() => expect(release).toBeDefined())
		head = 6n
		const fresh = freshHead(client)
		setTimeout(() => release?.(), 50)
		expect(await fresh).toBe(6n)
		expect(await held).toBe(5n)
		expect(requests).toBe(2)
	})
})
