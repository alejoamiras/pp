import { createPublicClient, custom, type Hex, numberToHex, type PublicClient, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { DEPLOYMENT } from "../test/client-fakes"
import type { ClientDeployment } from "./deployment"
import { exitReads } from "./exits-chain"
import { bridgedReceipts, resolveNullifier } from "./resolve"

const D: ClientDeployment = { ...DEPLOYMENT, deployBlock: 0n, token: toHex(1n, { size: 32 }), outbox: DEPLOYMENT.portal }

/**
 * A real viem client over a node that holds its first `eth_blockNumber` until released, so the bound
 * read meets viem's own cache and in-flight sharing. Records the block every log scan and call is bound to.
 */
function heldNode() {
	const n = { head: 5n, release: undefined as (() => void) | undefined, bounds: [] as bigint[] }
	let heads = 0
	const client = createPublicClient({
		transport: custom({
			async request({ method, params }: { method: string; params?: unknown }) {
				if (method === "eth_blockNumber") {
					const at = n.head
					if (++heads === 1) await new Promise<void>((r) => (n.release = r))
					return numberToHex(at)
				}
				if (method === "eth_getLogs") {
					n.bounds.push(BigInt((params as [{ toBlock: Hex }])[0].toBlock))
					return []
				}
				if (method === "eth_call") {
					n.bounds.push(BigInt((params as [unknown, Hex])[1]))
					return numberToHex(0n, { size: 32 })
				}
				throw new Error(`unexpected ${method}`)
			},
		}),
	})
	return { n, client }
}

const SCANS: [string, (c: PublicClient) => Promise<unknown>][] = [
	["the bridge lookup", (c) => bridgedReceipts(c, D, [11n])],
	["the nullifier resolver", (c) => resolveNullifier(c, D, { nullifier: 11n, amount: 70n, secretHash: 99n }, false)],
	[
		"the settled-exit lookup",
		(c) => exitReads({ deployment: D, reader: c, node: {} as never, receiptTimeoutMs: 0 }).settledTx({ epoch: 1n, leafId: 2n }),
	],
]

describe("scan bounds", () => {
	it.each(SCANS)("%s reads a head of its own while another head read on its client is in flight", async (_, scan) => {
		const { n, client } = heldNode()
		const held = client.getBlockNumber({ cacheTime: 0 })
		await vi.waitFor(() => expect(n.release).toBeDefined())
		n.head = 6n
		const done = scan(client)
		setTimeout(() => n.release?.(), 50)
		await done
		expect(await held).toBe(5n)
		expect(n.bounds.length).toBeGreaterThan(0)
		expect(n.bounds).toEqual(n.bounds.map(() => 6n))
	})
})
