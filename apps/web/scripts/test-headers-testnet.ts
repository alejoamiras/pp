/**
 * `serve --deployment` over a testnet build, checked from outside. The build must be the one for the
 * file (its receipt, its header set and the canonical SponsoredFPC). Over a copy of the file whose bot
 * and ASP ports are claimed ones held by two counting fake upstreams, the server must answer with the
 * build's header set, refuse every raw request below with no upstream call, forward each proxied route
 * with its query rebuilt, report a dead upstream as 502, and serve the proved circuit's files with the
 * bundle's sizes and digests. It must refuse to start on any other host, with a stale receipt and with
 * a stale header file.
 */
import { createHash } from "node:crypto"
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { connect } from "node:net"
import { join } from "node:path"
import { CIRCUIT_BUNDLES } from "@pp/pool-client/circuits"
import { HEADER_FILE, type SecurityHeaders, securityHeaders } from "../src/build/headers.ts"
import { TARGET_FILE } from "../src/build/plugins.ts"
import { sponsoredFpcAddress } from "../src/build/sponsored-fpc.ts"
import { readTestnetDeployment, testnetTarget } from "../src/build/testnet.ts"
import { PROVED_CIRCUIT } from "../src/data/adapters/circuit.ts"
import { claimPort } from "./ports"
import { bunRun, envWithout, type Group, scratchDir } from "./proc"
import { assertRefusal, assertServed, untilUp } from "./served"
import { loadTestnetServing } from "./testnet-serve"

const NAME = "serve --deployment"

interface Fake {
	/** Every request target it received, in order. */
	readonly seen: string[]
	close(): Promise<void>
}

/** A loopback upstream that records each request and answers JSON: 501 on note-events, as the mock does. */
function fakeUpstream(port: number, body: string): Promise<Fake> {
	const seen: string[] = []
	const server = createServer((req, res) => {
		seen.push(req.url ?? "")
		res.writeHead(req.url?.includes("/public/note-events") ? 501 : 200, { "Content-Type": "application/json" }).end(body)
	})
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () =>
			resolve({
				seen,
				close: () =>
					new Promise((done) => {
						server.closeAllConnections()
						server.close(() => done())
					}),
			}),
		)
	})
}

/** A copy of `file` whose upstreams are `bot` and `asp` on loopback. */
function withUpstreams(file: string, dir: string, bot: number, asp: number): string {
	const d = JSON.parse(readFileSync(file, "utf8")) as { network: Record<string, unknown>; pool: Record<string, unknown> }
	d.network.botPort = bot
	d.network.aspPort = asp
	d.pool.aspApiUrl = `http://127.0.0.1:${asp}`
	const copy = join(dir, "deployment.json")
	writeFileSync(copy, JSON.stringify(d))
	return copy
}

/**
 * Every status line the server writes for `request`, sent verbatim, until it closes the connection or
 * stays silent for a second: a smuggled second request would show as a second status.
 */
function rawStatuses(port: number, request: string): Promise<number[]> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1")
		let got = ""
		const done = () => resolve([...got.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1])))
		socket.setTimeout(1_000, () => socket.destroy())
		socket.on("data", (chunk: Buffer) => {
			got += chunk.toString("latin1")
		})
		socket.once("error", reject)
		socket.once("close", done)
		socket.write(request)
	})
}

type Raw = { method?: string; hosts?: string[]; extra?: string; close?: boolean }
function raw(target: string, host: string, o: Raw = {}): string {
	const hosts = (o.hosts ?? [host]).map((h) => `Host: ${h}\r\n`).join("")
	return `${o.method ?? "GET"} ${target} HTTP/1.1\r\n${hosts}${o.close === false ? "" : "Connection: close\r\n"}${o.extra ?? "\r\n"}`
}

/** Requests that must never reach an upstream, each with the exact statuses the server writes. */
function refusedRequests(port: number, asp: number, chain: number, entrypoint: string): [string, string, number[]][] {
	const host = `127.0.0.1:${port}`
	const q = `chainId=${chain}&entrypoint=${entrypoint}`
	const smuggled = `0\r\n\r\nGET /asp/public-key HTTP/1.1\r\nHost: ${host}\r\n\r\n`
	return [
		["absolute-form to the ASP", raw(`http://127.0.0.1:${asp}/association-set/root?${q}`, host), [404]],
		["absolute-form through the prefix", raw(`http://${host}/asp/association-set/root?${q}`, host), [404]],
		["scheme-relative", raw(`//127.0.0.1:${asp}/public-key`, host), [404]],
		["empty segment", raw("/asp//public-key", host), [404]],
		["dot segments", raw("/bot/../asp/public-key", host), [404]],
		["encoded dots", raw("/asp/%2e%2e/asp/public-key", host), [404]],
		["encoded slash", raw(`/asp/association-set%2froot?${q}`, host), [404]],
		["no Host", raw("/asp/public-key", host, { hosts: [] }), [400]],
		["two Hosts", raw("/asp/public-key", host, { hosts: [host, host] }), [421]],
		["another name", raw("/asp/public-key", host, { hosts: [`evil.example:${port}`] }), [421]],
		["a Host without the port", raw("/asp/public-key", host, { hosts: ["localhost"] }), [421]],
		[
			"Content-Length beside Transfer-Encoding",
			raw("/asp/admin", host, {
				close: false,
				extra: `Content-Length: ${smuggled.length}\r\nTransfer-Encoding: chunked\r\n\r\n${smuggled}`,
			}),
			[400],
		],
		["another chain", raw(`/asp/association-set/root?chainId=1&entrypoint=${entrypoint}`, host), [404]],
		["another entrypoint", raw(`/asp/association-set/root?chainId=${chain}&entrypoint=0x${"ab".repeat(20)}`, host), [404]],
		["an extra query key", raw(`/asp/association-set/root?${q}&x=1`, host), [404]],
		["a repeated query key", raw(`/asp/association-set/root?${q}&chainId=${chain}`, host), [404]],
		["the admin routes", raw("/asp/admin/association-set", host), [404]],
		["the label status route", raw("/asp/labels/1/status", host), [404]],
		["POST", raw("/bot/v1/snapshots/latest", host, { method: "POST", extra: "Content-Length: 0\r\n\r\n" }), [405]],
		["HEAD", raw("/bot/v1/snapshots/latest", host, { method: "HEAD" }), [405]],
	]
}

async function assertRefused(port: number, asp: number, chain: number, entrypoint: string, fakes: Fake[]): Promise<void> {
	for (const [what, request, want] of refusedRequests(port, asp, chain, entrypoint)) {
		const got = await rawStatuses(port, request)
		if (got.join() !== want.join()) throw new Error(`${NAME}, ${what}: statuses [${got}], not [${want}]`)
		const calls = fakes.reduce((n, f) => n + f.seen.length, 0)
		if (calls > 0) throw new Error(`${NAME}, ${what}: reached an upstream (${fakes.flatMap((f) => f.seen).join(", ")})`)
		console.log(`ok   ${NAME}, ${what}: HTTP ${got.join(", ")}, no upstream call`)
	}
	const named = await rawStatuses(port, raw("/", `localhost:${port}`))
	if (named.join() !== "200") throw new Error(`${NAME}: Host localhost:${port} got [${named}], not [200]`)
	console.log(`ok   ${NAME}: Host localhost:${port} is served`)
}

/** Each proxied route, forwarded once with its query rebuilt and its status and body passed through. */
async function assertForwarded(
	port: number,
	h: SecurityHeaders,
	upstreams: { bot: Fake; asp: Fake },
	chain: number,
	e: string,
): Promise<void> {
	const routes: [Fake, string, string, number][] = [
		[upstreams.bot, "/bot/v1/snapshots/latest?ignored=1", "/v1/snapshots/latest", 200],
		[
			upstreams.asp,
			`/asp/association-set/root?chainId=${chain}&entrypoint=${e}`,
			`/association-set/root?chainId=${chain}&entrypoint=${e}`,
			200,
		],
		[
			upstreams.asp,
			`/asp/${chain}/public/note-events?since=5&entrypoint=${e}`,
			`/${chain}/public/note-events?entrypoint=${e}&since=5`,
			501,
		],
	]
	for (const [fake, path, upstreamPath, status] of routes) {
		const before = fake.seen.length
		const { res, body } = await assertServed(NAME, port, path, {
			...h,
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
		})
		const seen = fake.seen.slice(before)
		if (res.status !== status || new TextDecoder().decode(body) !== '{"fake":true}' || seen.join() !== upstreamPath)
			throw new Error(`${NAME} ${path}: HTTP ${res.status}, upstream saw [${seen}]; want ${status} and [${upstreamPath}]`)
		console.log(`ok   ${NAME} ${path} reaches ${upstreamPath} once (HTTP ${status})`)
	}
}

async function assertUpstreamDown(port: number, bot: Fake): Promise<void> {
	await bot.close()
	const res = await fetch(`http://127.0.0.1:${port}/bot/v1/snapshots/latest`)
	const body = await res.text()
	if (res.status !== 502 || body !== "the ASP bot does not answer")
		throw new Error(`${NAME}: a dead bot gave HTTP ${res.status}: ${body}`)
	console.log(`ok   ${NAME}: a dead bot is HTTP 502 with its fixed text`)
}

/** The proved circuit's three files, each with the size and sha256 its bundle pins. */
async function assertCircuitFiles(port: number, bundle: keyof typeof CIRCUIT_BUNDLES): Promise<void> {
	const pin = CIRCUIT_BUNDLES[bundle].circuits[PROVED_CIRCUIT]
	for (const file of ["wasm", "provingKey", "verificationKey"] as const) {
		const res = await fetch(`http://127.0.0.1:${port}/${pin[file]}`)
		const bytes = new Uint8Array(await res.arrayBuffer())
		const digest = createHash("sha256").update(bytes).digest("hex")
		if (res.status !== 200 || bytes.length !== pin.sizes[file] || digest !== pin[`${file}Sha256`])
			throw new Error(`${NAME} /${pin[file]}: HTTP ${res.status}, ${bytes.length} bytes, sha256 ${digest}`)
		console.log(`ok   ${NAME} serves ${PROVED_CIRCUIT} ${file}: ${bytes.length} bytes, sha256 as pinned`)
	}
}

function startServe(outDir: string, port: number, deployment: string, host = "127.0.0.1"): Group {
	const args = ["serve", "--outDir", outDir, "--host", host, "--port", String(port), "--strictPort", "--deployment", deployment]
	return bunRun(args, { env: { ...envWithout(), PP_CIRCUITS_DIR: process.env.PP_CIRCUITS_DIR }, capture: true })
}

/** A copy of `outDir` with one file replaced must refuse to start, naming why. */
async function assertStale(
	outDir: string,
	port: number,
	deployment: string,
	file: string,
	content: unknown,
	reason: string,
): Promise<void> {
	const copy = scratchDir("headers-testnet-stale")
	try {
		cpSync(outDir, copy, { recursive: true })
		writeFileSync(join(copy, file), JSON.stringify(content))
		await assertRefusal(startServe(copy, port, deployment), port, `${NAME}, a stale ${file}`, reason)
	} finally {
		rmSync(copy, { recursive: true, force: true })
	}
}

async function assertRefusesToStart(outDir: string, port: number, deployment: string): Promise<void> {
	await assertRefusal(startServe(outDir, port, deployment, "0.0.0.0"), port, `${NAME} --host 0.0.0.0`, "binds 127.0.0.1 only")
	const target = testnetTarget(deployment, {}, await sponsoredFpcAddress())
	await assertStale(
		outDir,
		port,
		deployment,
		TARGET_FILE,
		{ ...target, rollupVersion: (target.rollupVersion ?? 0) + 1 },
		"is not the testnet build",
	)
	const other = securityHeaders({ ...target, l1RpcUrl: "https://rpc.example" })
	await assertStale(outDir, port, deployment, HEADER_FILE, other, "is not the header set")
}

async function assertServing(outDir: string, port: number, deployment: string, upstreams: { bot: Fake; asp: Fake }): Promise<void> {
	const d = readTestnetDeployment(deployment)
	const headers = JSON.parse(readFileSync(join(outDir, HEADER_FILE), "utf8")) as SecurityHeaders
	const g = startServe(outDir, port, deployment)
	try {
		await untilUp(NAME, port, g)
		for (const path of ["/", "/no/such/route", "/asp/no/such/route"]) await assertServed(NAME, port, path, headers)
		await assertRefused(port, Number(new URL(d.pool.aspApiUrl).port), d.network.l1ChainId, d.pool.entrypoint, [
			upstreams.bot,
			upstreams.asp,
		])
		await assertForwarded(port, headers, upstreams, d.network.l1ChainId, d.pool.entrypoint)
		await assertCircuitFiles(port, d.bundle)
		await assertUpstreamDown(port, upstreams.bot)
	} finally {
		await g.stop()
	}
}

/** @throws on the first check that fails; every server and claim it started is gone either way. */
export async function checkTestnet(file: string, outDir: string): Promise<void> {
	await loadTestnetServing(file, outDir)
	console.log(`ok   ${outDir} is the testnet build for ${file}, with the canonical SponsoredFPC`)
	const claims = await Promise.all(["headers", "headers-bot", "headers-asp"].map((s) => claimPort(s)))
	const [port, bot, asp] = claims.map((c) => c.port) as [number, number, number]
	const work = scratchDir("headers-testnet")
	try {
		const deployment = withUpstreams(file, work, bot, asp)
		const upstreams = { bot: await fakeUpstream(bot, '{"fake":true}'), asp: await fakeUpstream(asp, '{"fake":true}') }
		try {
			await assertServing(outDir, port, deployment, upstreams)
		} finally {
			await Promise.all([upstreams.bot.close(), upstreams.asp.close()])
		}
		await assertRefusesToStart(outDir, port, deployment)
	} finally {
		await Promise.all(claims.map((c) => c.release()))
		rmSync(work, { recursive: true, force: true })
	}
	console.log("test:headers --target passed")
}
