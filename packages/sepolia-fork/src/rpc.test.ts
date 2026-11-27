import { expect, test } from "bun:test"
import { httpRpc, RpcError, scrub } from "./rpc.ts"

const ENDPOINT = "https://rpc.example/v2/k3y?x=1"

test("an endpoint's path and query never reach a message, in any of its encoded forms", () => {
	const text = `a ${ENDPOINT} b ${encodeURIComponent(ENDPOINT)} c ${JSON.stringify(ENDPOINT)}`
	expect(scrub(text, [ENDPOINT])).toBe('a rpc.example b rpc.example c "rpc.example"')
})

test("RPC failures name the host only, including upstream errors a fork relays", async () => {
	const relayed = httpRpc("http://127.0.0.1:9", {
		hide: [ENDPOINT],
		fetch: (async () => Response.json({ error: { code: -32603, message: `error sending request for url (${ENDPOINT})` } })) as never,
	})
	const err = await relayed("eth_getCode").catch((e: unknown) => e)
	expect(err).toBeInstanceOf(RpcError)
	expect((err as RpcError).message).toBe("eth_getCode at 127.0.0.1:9: error sending request for url (rpc.example)")
	const limited = httpRpc(ENDPOINT, { fetch: (async () => new Response("slow down", { status: 429 })) as never })
	expect(await limited("eth_chainId").catch((e: Error) => e.message)).toBe("eth_chainId at rpc.example: HTTP 429")
	const down = httpRpc(ENDPOINT, {
		fetch: (async () => {
			throw new Error(`connect ECONNREFUSED ${ENDPOINT}`)
		}) as never,
	})
	expect(await down("eth_chainId").catch((e: Error) => e.message)).toBe("eth_chainId at rpc.example: connect ECONNREFUSED rpc.example")
})

test("a rate limit is retried with backoff, and fails naming the host once the retries run out", async () => {
	const waits: number[] = []
	const sleep = async (ms: number) => {
		waits.push(ms)
	}
	let calls = 0
	const flaky = httpRpc(ENDPOINT, {
		retries: 3,
		sleep,
		fetch: (async () => (++calls < 3 ? new Response("", { status: 429 }) : Response.json({ result: "0xaa36a7" }))) as never,
	})
	expect(await flaky("eth_chainId")).toBe("0xaa36a7")
	expect(waits).toEqual([1_000, 2_000])
	waits.length = 0
	const limited = httpRpc(ENDPOINT, {
		retries: 4,
		sleep,
		fetch: (async () => Response.json({ error: { code: -32005, message: "rate limit exceeded" } })) as never,
	})
	expect(await limited("eth_chainId").catch((e: Error) => e.message)).toBe("eth_chainId at rpc.example: rate limit exceeded")
	expect(waits).toEqual([1_000, 2_000, 4_000, 8_000])
	let refused = 0
	const down = httpRpc(ENDPOINT, {
		retries: 4,
		sleep,
		fetch: (async () => {
			refused++
			throw new Error("connect ECONNREFUSED")
		}) as never,
	})
	await expect(down("eth_chainId")).rejects.toThrow("ECONNREFUSED")
	expect(refused).toBe(1)
})
