import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort, releasePorts } from "@pp/run-isolation/ports"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { leakedListeners, loopbackPorts, type OwnedPorts, ownedPorts, parseListeners, portLeftovers } from "./owned"

it("finds every loopback URL's port in a nested value, IPv6 included, and no other", () => {
	const manifest = {
		l1Rpc: "http://127.0.0.1:41001",
		node: { url: "http://[::1]:41002/rpc" },
		bot: ["ws://localhost:41003"],
		remote: "https://rpc.example:41004",
		bare: "http://127.0.0.1/",
		text: "see http://127.0.0.1:41005",
		defaults: ["http://127.0.0.1:80", "https://localhost:443/"],
		outOfRange: "http://127.0.0.1:70000",
		userinfo: "http://127.0.0.1:1@rpc.example:41006",
	}
	expect([...loopbackPorts(manifest)].sort((a, b) => a - b)).toEqual([80, 443, 41001, 41002, 41003])
})

const ss = [
	'tcp   LISTEN 0      511        127.0.0.1:41001      0.0.0.0:*    users:(("bun",pid=101,fd=20),("pid=9",pid=102,fd=20))',
	"tcp   LISTEN 0      511          0.0.0.0:41002      0.0.0.0:*",
	'udp   UNCONN 0      0               [::]:41003         [::]:*    users:(("node",pid=103,fd=7))',
].join("\n")

describe("the leftover check's listeners", () => {
	it("reads every listening port with the pids ss can attribute", () => {
		expect([...parseListeners(ss)]).toEqual([
			[41001, [101, 102]],
			[41002, []],
			[41003, [103]],
		])
	})

	const owned: OwnedPorts = {
		owners: ["run-a"],
		ports: [41001, 41002, 41003, 41004],
		listeners: { 41001: [101], 41003: [103] },
	}
	const registry: Record<number, string> = { 41002: "run-a", 41004: "someone-else" }

	it("blames the run for a port its owner still claims, or a released port a snapshot listener still holds", () => {
		const live = new Map([
			[41001, [102, 101]],
			[41002, [500]],
			[41004, [600]],
		])
		expect(leakedListeners(owned, live, (p) => registry[p])).toEqual([41001, 41002])
	})

	it("does not blame the run for a stranger that bound a released port after it", () => {
		const live = new Map([[41003, [777]]])
		expect(leakedListeners(owned, live, (p) => registry[p])).toEqual([])
	})
})

const listen = (port: number) =>
	new Promise<Server>((resolve, reject) => {
		const server = createServer()
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () => resolve(server))
	})
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

describe.skipIf(process.platform !== "linux")("the leftover check on a live port", () => {
	let dir = ""
	const saved = process.env.PP_PORTS_REGISTRY
	beforeEach(() => {
		const base = join(homedir(), ".cache", "pp", "e2e-kit")
		mkdirSync(base, { recursive: true })
		dir = mkdtempSync(join(base, "owned-"))
		process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
	})
	afterEach(() => {
		if (saved === undefined) delete process.env.PP_PORTS_REGISTRY
		else process.env.PP_PORTS_REGISTRY = saved
		rmSync(dir, { recursive: true, force: true })
	})

	it("names the run's row and listener, then the listener alone once the row goes, then nothing", async () => {
		const owner = `owned-test-${process.pid}`
		const port = await claimPort(owner, "svc")
		const server = await listen(port)
		try {
			const o = ownedPorts([port])
			expect(o.owners).toEqual([owner])
			expect(portLeftovers(o)).toEqual([`a listener is still on port ${port}`, `ports.md still has rows owned by ${owner}`])
			await releasePorts(owner)
			expect(portLeftovers(o)).toEqual([`a listener is still on port ${port}`])
			await close(server)
			expect(portLeftovers(o)).toEqual([])
		} finally {
			if (server.listening) await close(server)
		}
	})
})
