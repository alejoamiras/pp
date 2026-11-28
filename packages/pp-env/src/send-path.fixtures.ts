// Test fixtures for the send path and its relay: a scriptable JSON-RPC stub and signed transactions.
import { privateKeyToAccount } from "viem/accounts"

export type StubAnswer = {
	status?: number
	hangMs?: number
	/** Held until this settles, after any `hangMs`. */
	until?: Promise<unknown>
	body?: string
	result?: unknown
	error?: { code: number; message: string }
}
export type Handler = (method: string, params: unknown[]) => StubAnswer

/** A loopback JSON-RPC endpoint answering from `handle`, recording every call. */
export function stub() {
	let handle: Handler = () => ({ result: null })
	const calls: { method: string; params: unknown[] }[] = []
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const b = (await req.json()) as { id: number; method: string; params: unknown[] }
			calls.push({ method: b.method, params: b.params })
			const a = handle(b.method, b.params)
			if (a.hangMs) await Bun.sleep(a.hangMs)
			if (a.until) await a.until
			if (a.body !== undefined) return new Response(a.body, { status: a.status ?? 200 })
			const payload = a.error ? { error: a.error } : { result: a.result }
			return Response.json({ jsonrpc: "2.0", id: b.id, ...payload }, { status: a.status ?? 200 })
		},
	})
	return {
		url: `http://127.0.0.1:${server.port}`,
		calls,
		sends: () => calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => c.params[0]),
		set(h: Handler) {
			handle = h
			calls.length = 0
		},
		stop: () => server.stop(true),
	}
}

// Anvil's published dev keys 0 and 1.
export const SENDER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
export const STRANGER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
export const signed = (nonce: number, chainId = 11155111, by = SENDER) =>
	by.signTransaction({ chainId, type: "eip1559", nonce, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, to: STRANGER.address })
