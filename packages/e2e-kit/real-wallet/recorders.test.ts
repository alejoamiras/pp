import { createServer } from "node:http"
import { connect } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type Listener, startEgressRecorder, startTripwire } from "./egress-recorder"
import { startNodeRecorder } from "./node-recorder"

const open: Listener[] = []
afterEach(async () => {
	for (const l of open.splice(0)) await l.close()
})

function rawRequest(port: number, head: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const s = connect(port, "127.0.0.1", () => s.write(head))
		let out = ""
		s.on("data", (d) => {
			out += d.toString()
		})
		s.on("end", () => resolve(out))
		s.on("error", reject)
	})
}

describe("egress recorder", () => {
	it("refuses CONNECT and plain requests with 403 and records each target", async () => {
		const rec = await startEgressRecorder()
		open.push(rec)
		expect(await rawRequest(rec.port, "CONNECT crs.example:443 HTTP/1.1\r\nHost: crs.example:443\r\n\r\n")).toMatch(/^HTTP\/1.1 403/)
		expect(await rawRequest(rec.port, "GET http://egress-canary.invalid/x HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1.1 403/)
		expect(rec.hits().map((h) => [h.method, h.target])).toEqual([
			["CONNECT", "crs.example:443"],
			["GET", "egress-canary.invalid:80"],
		])
	})

	it("counts connections on the tripwire", async () => {
		const wire = await startTripwire()
		open.push(wire)
		await rawRequest(wire.port, "GET / HTTP/1.1\r\n\r\n").catch(() => "")
		expect(wire.connections()).toBe(1)
	})
})

describe("node recorder", () => {
	it("relays single and batched calls unchanged and records witnesses and sent hashes", async () => {
		const upstream = createServer((req, res) => {
			let body = ""
			req.on("data", (d) => {
				body += d
			})
			req.on("end", () => {
				const answer = (m: { id: number; method: string; params: unknown[] }) => ({
					jsonrpc: "2.0",
					id: m.id,
					result: m.method === "aztec_getNullifierMembershipWitness" ? (m.params[1] === "0x01" ? { index: "1" } : null) : null,
				})
				const msg = JSON.parse(body)
				res.setHeader("content-type", "application/json")
				res.end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)))
			})
		})
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
		const addr = upstream.address()
		if (!addr || typeof addr === "string") throw new Error("no address")
		open.push({ port: addr.port, close: () => new Promise((r) => upstream.close(() => r())) })
		const rec = await startNodeRecorder(`http://127.0.0.1:${addr.port}`, async (p) => `hash-of-${JSON.stringify(p)}`)
		open.push(rec)

		const post = (body: unknown) =>
			fetch(rec.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
				r.json(),
			)
		const batch = await post([
			{ jsonrpc: "2.0", id: 1, method: "aztec_getNullifierMembershipWitness", params: ["latest", "0x02"] },
			{ jsonrpc: "2.0", id: 2, method: "aztec_getNullifierMembershipWitness", params: ["latest", "0x01"] },
		])
		expect(batch).toEqual([
			{ jsonrpc: "2.0", id: 1, result: null },
			{ jsonrpc: "2.0", id: 2, result: { index: "1" } },
		])
		await post({ jsonrpc: "2.0", id: 3, method: "aztec_sendTx", params: [{ data: "x" }] })

		expect(rec.nullifierQueries()).toEqual([
			{ value: "0x02", found: false, seq: 0, answered: 2 },
			{ value: "0x01", found: true, seq: 1, answered: 2 },
		])
		expect(rec.sentTxHashes()).toEqual(['hash-of-{"data":"x"}'])
	})

	async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
		const server = createServer(handler)
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
		const addr = server.address()
		if (!addr || typeof addr === "string") throw new Error("no address")
		open.push({ port: addr.port, close: () => new Promise((r) => server.close(() => r())) })
		return addr.port
	}

	it("forwards only to its upstream, whatever the request target names", async () => {
		let strangerHits = 0
		const stranger = await serve((_req, res) => {
			strangerHits++
			res.end()
		})
		const upstream = await serve((_req, res) => res.end("{}"))
		const rec = await startNodeRecorder(`http://127.0.0.1:${upstream}`)
		open.push(rec)
		for (const target of [`//127.0.0.1:${stranger}/x`, `http://127.0.0.1:${stranger}/x`])
			await rawRequest(rec.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
		expect(strangerHits).toBe(0)
	})

	it("records a send the upstream took without answering, and no witness answer as unknown", async () => {
		const upstream = await serve((req, res) => {
			let body = ""
			req.on("data", (d) => {
				body += d
			})
			req.on("end", () => {
				const msg = JSON.parse(body)
				if (msg.method === "aztec_sendTx") return req.socket.destroy()
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "busy" } }))
			})
		})
		const rec = await startNodeRecorder(`http://127.0.0.1:${upstream}`, async () => "0xabc")
		open.push(rec)
		const post = (body: unknown) => fetch(rec.url, { method: "POST", body: JSON.stringify(body) }).then((r) => r.status)
		expect(await post({ jsonrpc: "2.0", id: 1, method: "aztec_sendTx", params: [{}] })).toBe(502)
		await post({ jsonrpc: "2.0", id: 2, method: "aztec_getNullifierMembershipWitness", params: ["latest", "0x02"] })
		expect(rec.sentTxHashes()).toEqual(["0xabc"])
		expect(rec.nullifierQueries()).toMatchObject([{ value: "0x02", found: undefined }])
	})

	it("orders each witness answer against the send, and takes no answer from a failed response", async () => {
		let release = () => {}
		const sendSeen = new Promise<void>((r) => {
			release = r
		})
		const upstream = await serve((req, res) => {
			let body = ""
			req.on("data", (d) => {
				body += d
			})
			req.on("end", async () => {
				const msg = JSON.parse(body)
				if (msg.method === "aztec_sendTx") release()
				else if (msg.params[1] === "0x03") await sendSeen
				res.statusCode = msg.params?.[1] === "0x04" ? 500 : 200
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }))
			})
		})
		const rec = await startNodeRecorder(`http://127.0.0.1:${upstream}`, async () => "0xabc")
		open.push(rec)
		const post = (body: unknown) => fetch(rec.url, { method: "POST", body: JSON.stringify(body) })
		await post({ jsonrpc: "2.0", id: 1, method: "aztec_getNullifierMembershipWitness", params: ["latest", "0x04"] })
		const late = post({ jsonrpc: "2.0", id: 2, method: "aztec_getNullifierMembershipWitness", params: ["latest", "0x03"] })
		await expect.poll(() => rec.nullifierQueries().length).toBe(2)
		await post({ jsonrpc: "2.0", id: 3, method: "aztec_sendTx", params: [{}] })
		await late
		const send = rec.calls().find((c) => c.name === "sendTx")
		const [failed, answeredLate] = rec.nullifierQueries()
		expect(failed).toMatchObject({ value: "0x04", found: undefined, answered: undefined })
		expect(answeredLate?.seq).toBeLessThan(send?.seq ?? 0)
		expect(answeredLate?.answered).toBeGreaterThan(send?.seq ?? 0)
	})
})
