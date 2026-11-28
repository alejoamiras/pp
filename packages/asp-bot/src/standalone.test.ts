import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import type { RootRecord } from "@pp/label-paths"
import { claimRows, PortClaimConflict } from "@pp/run-isolation/ports"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DEFAULT_USER_AGENT, fetchLeaves } from "./asp"
import { type Ports, Poster } from "./loop"
import { SnapshotBook } from "./server"
import { checkStandaloneConfig, loggedStep, runStandaloneBot, type StandaloneBotConfig, scopedLeaves, trackPosts } from "./standalone"

const ENTRYPOINT = "0xeb3e3961008952348445513e418ad6f43c23ca9a"
const LEAVES = [aspLeaf(11n), aspLeaf(22n), aspLeaf(33n)]

/** Answers 404 unless the query names the pool. */
async function stubAsp() {
	const queries: Record<string, string>[] = []
	const agents: (string | undefined)[] = []
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub")
		const q = Object.fromEntries(url.searchParams)
		queries.push(q)
		agents.push(req.headers["user-agent"])
		if (url.pathname !== "/association-set/leaves" || q.chainId !== "11155111" || q.entrypoint !== ENTRYPOINT)
			return res.writeHead(404).end(`No enabled pool found for chainId ${q.chainId}`)
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ leaves: LEAVES.map(String) }))
	})
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return { url, queries, agents, close: () => new Promise<void>((ok) => server.close(() => ok())) }
}

const config = (o: Partial<StandaloneBotConfig["deployment"]> & { port?: number; runId?: string } = {}): StandaloneBotConfig => ({
	deployment: {
		l1Rpc: "http://127.0.0.1:9",
		aztecNode: "http://127.0.0.1:9",
		aspApiUrl: "http://127.0.0.1:9",
		aspRegistry: "0x35d29efdcf067599ab4a53cf40229477f0b1ca9c",
		entrypoint: ENTRYPOINT,
		chainId: 11155111,
		registry: `0x${"01".repeat(32)}`,
		tokens: [],
		...o,
	},
	runId: o.runId ?? `standalone-test-${process.pid}`,
	port: o.port ?? 43_210,
	inclusionMarginSec: 300,
	postTimeoutSec: 600,
})

describe("the standalone bot", () => {
	it("sends the pool's chainId and entrypoint, and posts a leaf set whose root is the chain's", async () => {
		const asp = await stubAsp()
		try {
			await expect(fetchLeaves(asp.url)).rejects.toThrow("HTTP 404")
			let record: RootRecord = { sequence: 0n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
			const ports: Ports = {
				tip: async () => ({ number: 10, hash: "0x01", time: 1_000n }),
				record: async () => record,
				poster: async () => 0xb07n,
				selectL1: async () => ({ number: 10n, hash: "0x0a", timestamp: 900n }),
				aspRootAt: async () => buildLeanImt(LEAVES).root,
				aspLeaves: scopedLeaves(config({ aspApiUrl: asp.url }).deployment),
				birthLeaves: async () => [],
				post: async (a) => {
					record = { ...a }
					return { inclusionTime: 1_072n }
				},
				log: () => {},
			}
			const tick = await new Poster(ports, new SnapshotBook(), { self: 0xb07n, inclusionMarginSec: 300n }).tick()
			expect(tick.post).toBe(true)
			expect(record.poolRoot).toBe(buildLeanImt(LEAVES).root)
			expect(asp.queries.at(-1)).toEqual({ chainId: "11155111", entrypoint: ENTRYPOINT })
			await scopedLeaves(config({ aspApiUrl: asp.url }).deployment, "pp-aztec-bridge-bot/9 (b)")()
			expect(asp.agents.slice(-2)).toEqual([DEFAULT_USER_AGENT, "pp-aztec-bridge-bot/9 (b)"])
		} finally {
			await asp.close()
		}
	})

	describe("before it touches a network", () => {
		const parent = join(homedir(), ".cache/pp/asp-bot")
		let dir: string
		const saved = process.env.PP_PORTS_REGISTRY
		beforeAll(() => {
			mkdirSync(parent, { recursive: true })
			dir = mkdtempSync(join(parent, "standalone-test-"))
			process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
		})
		afterAll(() => {
			if (saved === undefined) delete process.env.PP_PORTS_REGISTRY
			else process.env.PP_PORTS_REGISTRY = saved
			rmSync(dir, { recursive: true, force: true })
		})

		it("refuses a port another run holds, and claims nothing of its own", async () => {
			await claimRows("first-bot", { "asp-bot": 43_211 }, process.pid)
			const signal = new AbortController().signal
			await expect(
				runStandaloneBot(config({ port: 43_211, runId: "second-bot" }), { poster: Fr.random() }, { signal }),
			).rejects.toBeInstanceOf(PortClaimConflict)
			expect(readFileSync(join(dir, "ports.md"), "utf8")).not.toContain("second-bot")
		})

		it("resolves on an abort between stages, releasing its own row and no sibling's under the same run", async () => {
			await claimRows("shared-run", { sibling: 43_212 }, process.pid)
			// Aborts at the check after the server binds, before the wallet starts.
			let checks = 0
			const signal = {
				get aborted() {
					return checks >= 2
				},
				throwIfAborted() {
					if (++checks >= 2) throw new DOMException("aborted", "AbortError")
				},
				addEventListener() {},
			} as unknown as AbortSignal
			const lines: { event: string; step?: unknown; at?: unknown; ms?: unknown; settled?: unknown }[] = []
			const log = (event: string, fields: Record<string, unknown>) => lines.push({ event, ...fields })
			await expect(
				runStandaloneBot(config({ port: 43_213, runId: "shared-run" }), { poster: Fr.random() }, { signal, log }),
			).resolves.toBeUndefined()
			const rows = readFileSync(join(dir, "ports.md"), "utf8")
			expect(rows).toContain("| 43212 | sibling | shared-run |")
			expect(rows).not.toContain("43213")
			// The wallet never started, so the teardown begins at the drain, which has no step to wait for.
			expect(lines.map((l) => l.step ?? l.event)).toEqual(["drain", "server_close", "store_remove", "port_release", "teardown_done"])
			expect(lines[0]?.settled).toBe(true)
			for (const l of lines) {
				expect(Date.parse(String(l.at)), l.event).toBeGreaterThan(0)
				expect(l.ms, l.event).toBeGreaterThanOrEqual(0)
			}
		})

		it.each([
			["an intake secret without tokens", {}, { intake: Fr.random() }],
			["tokens without an intake secret", { tokens: [`0x${"02".repeat(32)}` as const] }, {}],
		])("refuses %s", async (_, deployment, secrets) => {
			const signal = new AbortController().signal
			await expect(runStandaloneBot(config(deployment), { poster: Fr.random(), ...secrets }, { signal })).rejects.toBeInstanceOf(
				RangeError,
			)
		})

		it("names the bot and the pool in every ASP request, or refuses the config before any", () => {
			const check =
				(o: Record<string, unknown>, d: Record<string, unknown> = {}) =>
				() =>
					checkStandaloneConfig({ ...config(d as never), ...o } as StandaloneBotConfig, { poster: Fr.random() })
			for (const userAgent of [undefined, "pp-aztec-bridge-bot", "pp-aztec-bridge-bot/0.1.0 (instance a)"])
				expect(check({ userAgent })).not.toThrow()
			for (const userAgent of [
				true,
				"curl/8",
				" pp-aztec-bridge-bot",
				"pp-aztec-bridge-bot-extra",
				"pp-aztec-bridge-bot\r\nx: y",
				`pp-aztec-bridge-bot/${"a".repeat(110)}`,
			])
				expect(check({ userAgent })).toThrow("userAgent must be")
			for (const chainId of [0, 1.5, "11155111"]) expect(check({}, { chainId })).toThrow("chainId")
			for (const entrypoint of ["0x01", `${ENTRYPOINT}00`, 5]) expect(check({}, { entrypoint })).toThrow("entrypoint")
		})
	})

	describe("the teardown log", () => {
		it("knows a post is in flight from its start until it settles, either way", async () => {
			let settle = (_: boolean) => {}
			const post: Ports["post"] = () =>
				new Promise((ok, fail) => (settle = (passes) => (passes ? ok({ inclusionTime: 1n }) : fail(new Error("reverted")))))
			const { ports, postingSince } = trackPosts({ post } as Ports)
			const args = { sequence: 1n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
			for (const passes of [true, false]) {
				expect(postingSince()).toBeUndefined()
				const posted = ports.post(args)
				expect(postingSince()).toBeGreaterThan(0)
				settle(passes)
				await (passes ? expect(posted).resolves.toEqual({ inclusionTime: 1n }) : expect(posted).rejects.toThrow("reverted"))
				expect(postingSince()).toBeUndefined()
			}
		})

		it("logs a step that throws with its error, and still throws", async () => {
			const lines: Record<string, unknown>[] = []
			const step = loggedStep(
				(event, fields) => lines.push({ event, ...fields }),
				"port_release",
				async () => {
					throw new Error("the port registry stayed locked")
				},
			)
			await expect(step()).rejects.toThrow("the port registry stayed locked")
			expect(lines).toEqual([
				expect.objectContaining({ event: "teardown_step", step: "port_release", error: "the port registry stayed locked" }),
			])
		})
	})
})
