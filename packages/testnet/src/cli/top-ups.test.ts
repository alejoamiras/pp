import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { type Address, type Hex, keccak256, parseTransaction } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Plan } from "../funding"
import type { TestnetDeployment } from "../schema"
import { sendTopUps } from "./top-ups"
import { clientsOf } from "./common"
import { l1Sender } from "./wallet"

// The chain both endpoints serve: a transaction of the deployer's at nonce 5 landed after the plan's
// snapshot, so the count now reads 6 and nonce 5 is taken.
const LANDED_NONCE = 5
const sends: Hex[] = []
const answer = (method: string, params: unknown[]): object => {
	if (method === "eth_chainId") return { result: "0xaa36a7" }
	if (method === "eth_getTransactionCount") return { result: `0x${(LANDED_NONCE + 1).toString(16)}` }
	if (method === "eth_sendRawTransaction") {
		const raw = params[0] as Hex
		sends.push(raw)
		return Number(parseTransaction(raw).nonce) <= LANDED_NONCE
			? { error: { code: -32000, message: "nonce too low" } }
			: { result: keccak256(raw) }
	}
	return { result: null }
}

let server: Server
let url: string
beforeAll(async () => {
	server = createServer((req, res) => {
		let body = ""
		req.on("data", (b) => (body += b))
		req.on("end", () => {
			const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] }
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params ?? []) }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe("a top-up run", () => {
	it("whose snapshot misses a transaction that landed since signs at the snapshot's nonce, fails closed and pays nothing", async () => {
		const key = generatePrivateKey()
		const deployer = privateKeyToAccount(key).address
		const d = { network: { l1Rpc: url, l1SendRpc: url, l1ChainId: 11155111 } } as TestnetDeployment
		const sender = l1Sender(d, key, "L1 deployer", deployer)
		const recipient: Address = "0x00000000000000000000000000000000000000a1"
		const plan: Plan = {
			sends: [{ roles: ["guardian"], address: recipient, balance: 0n, need: 1000n, amount: 1000n, transferGas: 21_000n }],
			deployerNeed: 0n,
			transferGas: 0n,
			total: 1000n,
		}
		const run = sendTopUps(plan, {
			l1: clientsOf(d).l1,
			sender,
			deployer,
			limitsFrom: undefined,
			fees: { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
			nonce: LANDED_NONCE,
		})
		await expect(run).rejects.toThrow(/lost nonce 5 to another transaction/)
		sender.path.close()
		expect(sends.map((raw) => Number(parseTransaction(raw).nonce))).toEqual([LANDED_NONCE])
	})
})
