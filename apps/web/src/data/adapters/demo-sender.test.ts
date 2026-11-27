import { type Address, getAddress, type Hash } from "viem"
import { describe, expect, test } from "vitest"
import { demoSender } from "./demo-sender"

const ENDPOINT = "http://127.0.0.1:8545"
const ADDRESS = getAddress("0x00000000000000000000000000000000000000aa")
const PORTAL: Address = "0x00000000000000000000000000000000000000d4"
const TX: Hash = `0x${"ab".repeat(32)}`

/** A node on `chainId` whose portal holds `code`; it logs each request's method, URL and init. */
function node(chainId: number, code = "0x6001") {
	const calls: { url: string; method: string; init: RequestInit }[] = []
	const doFetch = (async (url: string, init: RequestInit) => {
		const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
		calls.push({ url, method, init })
		const result = { eth_chainId: `0x${chainId.toString(16)}`, eth_getCode: code, eth_sendTransaction: TX }[method] ?? "0x1"
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }))
	}) as unknown as typeof fetch
	return { doFetch, calls, sends: () => calls.filter((c) => c.method === "eth_sendTransaction").length }
}

const sender = (n: ReturnType<typeof node>, l1RpcUrl = ENDPOINT) =>
	demoSender({ l1RpcUrl, chainId: 31337, portal: PORTAL, address: ADDRESS, fetch: n.doFetch })

const send = (s: ReturnType<typeof sender>, tx: { from: Address; to: Address }) =>
	s.provider.request({ method: "eth_sendTransaction", params: [{ ...tx, value: "0x0" }] })

describe("the local demo's sender", () => {
	test("talks only to a plain loopback http endpoint", () => {
		for (const url of ["https://127.0.0.1:8545", "http://rpc.example:8545", "http://user:pw@127.0.0.1:8545", "http://[::1]:8545"])
			expect(() => sender(node(31337), url)).toThrow(/refuses the endpoint/)
	})

	test("sends nothing until the node serves the chain and the portal has code, then only from itself to the portal", async () => {
		const n = node(31337)
		const s = sender(n)
		await expect(send(s, { from: ADDRESS, to: PORTAL })).rejects.toMatchObject({ code: 4001 })
		await expect(s.provider.request({ method: "eth_accounts" })).resolves.toEqual([ADDRESS])
		await expect(s.provider.request({ method: "personal_sign", params: ["0x00", ADDRESS] })).rejects.toMatchObject({ code: 4200 })
		await s.ready()
		await expect(send(s, { from: PORTAL, to: PORTAL })).rejects.toMatchObject({ code: 4001 })
		await expect(send(s, { from: ADDRESS, to: ADDRESS })).rejects.toMatchObject({ code: 4001 })
		for (const odd of [
			{ from: "0x1234" as Address, to: PORTAL },
			{ from: ADDRESS, to: "not an address" as Address },
		])
			await expect(send(s, odd)).rejects.toMatchObject({ code: 4001 })
		await expect(send(s, { from: ADDRESS, to: PORTAL })).resolves.toBe(TX)
		expect(n.sends()).toBe(1)
		for (const c of n.calls) expect([c.url, c.init.redirect, c.init.credentials]).toEqual([ENDPOINT, "error", "omit"])
	})

	test("a node on another chain, or a portal with no code, fails the check and keeps every send refused", async () => {
		for (const [n, code] of [
			[node(1), "CHAIN_MISMATCH"],
			[node(31337, "0x"), "DEPLOYMENT_MISMATCH"],
			[node(31337, ""), "DEPLOYMENT_MISMATCH"],
			[node(31337, "0x60zz"), "DEPLOYMENT_MISMATCH"],
		] as const) {
			const s = sender(n)
			await expect(s.ready()).rejects.toMatchObject({ code })
			await expect(send(s, { from: ADDRESS, to: PORTAL })).rejects.toMatchObject({ code: 4001 })
			expect(n.sends()).toBe(0)
		}
	})
})
