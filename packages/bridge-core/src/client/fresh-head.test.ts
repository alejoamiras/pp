import { createPublicClient, custom, type Hex, numberToHex, type PublicClient, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { DEPLOYMENT } from "../test/client-fakes"
import type { ClientDeployment } from "./deployment"
import { settledAt } from "./exits"
import { exitReads } from "./exits-chain"
import { bridgedReceipts, resolveNullifier } from "./resolve"
import { LOCAL_TIMING } from "./timing"
import type { ExitTicket } from "./types"

const D: ClientDeployment = { ...DEPLOYMENT, deployBlock: 0n, token: toHex(1n, { size: 32 }), outbox: DEPLOYMENT.portal }
const TICKET: ExitTicket = {
	kind: "public",
	token: D.token,
	payee: "0x00000000000000000000000000000000000000e5",
	amount: 1n,
	l2TxHash: toHex(2n, { size: 32 }),
	messageIndexInTx: 0,
}

/** The block an `eth_call` names; a header's hash here is its number, so an EIP-1898 read records the same bound. */
const callBound = (params: unknown): bigint => {
	const at = (params as [unknown, Hex | { blockHash: Hex }])[1]
	return BigInt(typeof at === "string" ? at : at.blockHash)
}

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
					n.bounds.push(callBound(params))
					return numberToHex(0n, { size: 32 })
				}
				if (method === "eth_getBlockByNumber") {
					const [tag] = params as [Hex | "latest"]
					const at = tag === "latest" ? n.head : BigInt(tag)
					return { number: numberToHex(at), hash: toHex(at, { size: 32 }) }
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
		(c) =>
			settledAt(exitReads({ deployment: D, reader: c, node: {} as never, timing: LOCAL_TIMING }), TICKET, { epoch: 1n, leafId: 2n }),
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
