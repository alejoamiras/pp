import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createPublicClient, encodeErrorResult, http, parseAbi } from "viem"
import { afterAll, expect, it } from "vitest"
import { forkReads } from "./fork-client"

const servers: Server[] = []
afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))))

async function serve(handler: RequestListener): Promise<string> {
	const server = createServer(handler)
	servers.push(server)
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const CONTRACT = "0x1111111111111111111111111111111111111111"
const ABI = parseAbi([
	"error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)",
	"function latestASPRoot() view returns (uint256)",
])

it("does not follow an OffchainLookup revert, which a client with CCIP-read on follows", async () => {
	let lookups = 0
	const gateway = await serve((_, res) => {
		lookups++
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: "0x" }))
	})
	const revert = encodeErrorResult({
		abi: ABI,
		errorName: "OffchainLookup",
		args: [CONTRACT, [`${gateway}/{sender}/{data}`], "0x", "0x12345678", "0x"],
	})
	const fork = await serve((req, res) => {
		let body = ""
		req.on("data", (c) => {
			body += c
		})
		req.on("end", () => {
			const { id, params } = JSON.parse(body) as { id: number; params: [{ data?: string }] }
			// The callback a followed lookup makes answers, so the client that follows stops there.
			const answer = params[0]?.data?.startsWith("0x12345678")
				? { result: `0x${"1".padStart(64, "0")}` }
				: { error: { code: 3, message: "execution reverted", data: revert } }
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer }))
		})
	})
	const read = (client: ReturnType<typeof forkReads>) =>
		client.readContract({ address: CONTRACT, abi: ABI, functionName: "latestASPRoot" }).catch(() => undefined)

	await read(createPublicClient({ transport: http(fork) }))
	expect(lookups).toBe(1)
	await read(forkReads(fork))
	expect(lookups).toBe(1)
})
