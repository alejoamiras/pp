/**
 * `serve --deployment` over a testnet build, checked from outside: against counting fake upstreams on
 * claimed ports and a fake `HTTP_PROXY`/`HTTPS_PROXY` that no loopback forward may reach. For pool1,
 * whose ASP is the operator's pinned https API, that proxy records the CONNECT each upstream request
 * makes and refuses it, so the check counts requests to the operator and never sends one.
 */
import { createHash } from "node:crypto"
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http"
import { type AddressInfo, connect } from "node:net"
import { join } from "node:path"
import { CIRCUIT_BUNDLES } from "@pp/pool-client/circuits"
import { HEADER_FILE, type SecurityHeaders, securityHeaders } from "../src/build/headers.ts"
import { TARGET_FILE } from "../src/build/plugins.ts"
import { sponsoredFpcAddress } from "../src/build/sponsored-fpc.ts"
import { PINNED_URLS } from "@pp/testnet/schema"
import { readTestnetDeployment, testnetTarget } from "../src/build/testnet.ts"
import { PROVED_CIRCUIT } from "../src/data/adapters/circuit.ts"
import { claimPort } from "./ports"
import { bunRun, envWithout, type Group, scratchDir } from "./proc"
import { USER_AGENT, UPSTREAM_DOWN } from "./proxy"
import { assertRefusal, assertServed, releaseAll, untilUp } from "./served"
import { loadTestnetServing } from "./testnet-serve"

const NAME = "serve --deployment"
const BODY = '{"fake":true}'
/** Sent by the client on a proxied route; none may reach an upstream. */
const CLIENT_HEADERS = { cookie: "s=1", authorization: "Bearer t", "x-forwarded-for": "203.0.113.1", origin: "http://evil.example" }

interface Fake {
	readonly port: number
	/** Each request's target and headers, in order. */
	readonly seen: { url: string; headers: IncomingHttpHeaders }[]
	/** Each CONNECT's authority, in order; every one is answered 502. */
	readonly connects: string[]
	close(): Promise<void>
}

function listen(port: number, answer: RequestListener): Promise<Fake> {
	const seen: Fake["seen"] = []
	const connects: string[] = []
	const server = createServer((req, res) => {
		seen.push({ url: req.url ?? "", headers: req.headers })
		answer(req, res)
	})
	server.on("connect", (req, socket) => {
		connects.push(req.url ?? "")
		socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
	})
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () =>
			resolve({
				port: (server.address() as AddressInfo).port,
				seen,
				connects,
				close: () =>
					new Promise((done) => {
						server.closeAllConnections()
						server.close(() => done())
					}),
			}),
		)
	})
}

/** Answers JSON with headers that must not cross the proxy; 501 on note events, as the mock does. */
const upstreamAnswer: RequestListener = (req, res) => {
	const status = req.url?.includes("/public/note-events") ? 501 : 200
	res.writeHead(status, { "Content-Type": "application/json", "Set-Cookie": "u=1", "X-Upstream": "1" }).end(BODY)
}

/** A copy of `file` whose bot is `bot` on loopback, and whose ASP is `asp` there too unless it is the operator's. */
export function withUpstreams(file: string, dir: string, bot: number, asp: number): string {
	const d = JSON.parse(readFileSync(file, "utf8")) as { target: string; network: Record<string, unknown>; pool: Record<string, unknown> }
	d.network.botPort = bot
	if (d.target === "own") {
		d.network.aspPort = asp
		d.pool.aspApiUrl = `http://127.0.0.1:${asp}`
	}
	const copy = join(dir, "deployment.json")
	writeFileSync(copy, JSON.stringify(d))
	return copy
}

/**
 * Every status line the server writes for `request`, sent verbatim, and whether the server closed the
 * connection within a second. A smuggled second request would show as a second status.
 */
function rawStatuses(port: number, request: string): Promise<{ statuses: number[]; closed: boolean }> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1")
		let got = ""
		let closed = true
		socket.setTimeout(1_000, () => {
			closed = false
			socket.destroy()
		})
		socket.on("data", (chunk: Buffer) => {
			got += chunk.toString("latin1")
		})
		socket.once("error", reject)
		socket.once("close", () => resolve({ statuses: [...got.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1])), closed }))
		socket.write(request)
	})
}

type Raw = { method?: string; hosts?: string[]; extra?: string; close?: boolean }
/** Each request accepts HTML, so a target that reached the app's fallback would answer 200. */
function raw(target: string, host: string, o: Raw = {}): string {
	const hosts = (o.hosts ?? [host]).map((h) => `Host: ${h}\r\n`).join("")
	const close = o.close === false ? "" : "Connection: close\r\n"
	return `${o.method ?? "GET"} ${target} HTTP/1.1\r\n${hosts}Accept: text/html\r\n${close}${o.extra ?? "\r\n"}`
}

function refusedRequests(port: number, asp: number, chain: number, entrypoint: string): [string, string, number[]][] {
	const host = `127.0.0.1:${port}`
	const q = `chainId=${chain}&entrypoint=${entrypoint}`
	const smuggled = `0\r\n\r\nGET /asp/public-key HTTP/1.1\r\nHost: ${host}\r\n\r\n`
	return [
		["absolute-form to the ASP", raw(`http://127.0.0.1:${asp}/association-set/root?${q}`, host), [400]],
		["absolute-form through the prefix", raw(`http://${host}/asp/association-set/root?${q}`, host), [400]],
		["scheme-relative", raw(`//127.0.0.1:${asp}/public-key`, host), [400]],
		["empty segment", raw("/asp//public-key", host), [404]],
		["dot segments", raw("/bot/../asp/public-key", host), [404]],
		["encoded dots", raw("/asp/%2e%2e/asp/public-key", host), [404]],
		["encoded slash", raw(`/asp/association-set%2froot?${q}`, host), [404]],
		["an empty query on a route without one", raw("/asp/public-key?", host), [404]],
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
		const { statuses, closed } = await rawStatuses(port, request)
		if (statuses.join() !== want.join() || !closed)
			throw new Error(
				`${NAME}, ${what}: statuses [${statuses}]${closed ? "" : ", connection left open"}; want [${want}], then closed`,
			)
		const calls = fakes.flatMap((f) => f.seen.map((s) => s.url))
		if (calls.length > 0) throw new Error(`${NAME}, ${what}: reached an upstream (${calls.join(", ")})`)
		console.log(`ok   ${NAME}, ${what}: HTTP ${statuses.join(", ")}, closed, no upstream call`)
	}
	const named = await rawStatuses(port, raw("/", `localhost:${port}`))
	if (named.statuses.join() !== "200") throw new Error(`${NAME}: Host localhost:${port} got [${named.statuses}], not [200]`)
	console.log(`ok   ${NAME}: Host localhost:${port} is served`)
}

type Upstreams = { bot: Fake; asp: Fake | null }

async function assertForwarded(port: number, h: SecurityHeaders, up: Upstreams, chain: number, e: string): Promise<void> {
	const routes: [Fake, string, string, number][] = [[up.bot, "/bot/v1/snapshots/latest?ignored=1", "/v1/snapshots/latest", 200]]
	if (up.asp)
		routes.push(
			[
				up.asp,
				`/asp/association-set/root?chainId=${chain}&entrypoint=${e}`,
				`/association-set/root?chainId=${chain}&entrypoint=${e}`,
				200,
			],
			// The own pool's mock is never cached: the same route asked again reaches it again.
			[
				up.asp,
				`/asp/association-set/root?chainId=${chain}&entrypoint=${e}`,
				`/association-set/root?chainId=${chain}&entrypoint=${e}`,
				200,
			],
			[
				up.asp,
				`/asp/${chain}/public/note-events?since=5&entrypoint=${e}`,
				`/${chain}/public/note-events?entrypoint=${e}&since=5`,
				501,
			],
		)
	for (const [fake, path, upstreamPath, status] of routes) {
		const before = fake.seen.length
		const { res, body } = await assertServed(NAME, port, path, {
			...h,
			"Cache-Control": "no-store",
			"Content-Type": "application/json",
		})
		const seen = fake.seen.slice(before).map((s) => s.url)
		if (res.status !== status || new TextDecoder().decode(body) !== BODY || seen.join() !== upstreamPath)
			throw new Error(`${NAME} ${path}: HTTP ${res.status}, upstream saw [${seen}]; want ${status} and [${upstreamPath}]`)
		console.log(`ok   ${NAME} ${path} reaches ${upstreamPath} once (HTTP ${status})`)
	}
}

/**
 * The operator's ASP behind its allowance, reached only as a CONNECT through the fake proxy, which
 * refuses it: each URL is one CONNECT however often it is asked, the answer is the ASP's fixed 502, and
 * note events are answered here without one.
 */
async function assertOperator(port: number, proxy: Fake, chain: number, e: string): Promise<void> {
	const host = new URL(PINNED_URLS.aspApi[0]).host
	const asked: [string, number, string][] = [
		[`/asp/association-set/root?chainId=${chain}&entrypoint=${e}`, 502, UPSTREAM_DOWN.asp],
		[`/asp/association-set/root?chainId=${chain}&entrypoint=${e}`, 502, UPSTREAM_DOWN.asp],
		["/asp/public-key", 502, UPSTREAM_DOWN.asp],
		[`/asp/${chain}/public/note-events?since=5&entrypoint=${e}`, 501, "note events are read from the chain"],
	]
	for (const [path, status, body] of asked) {
		const res = await fetch(`http://127.0.0.1:${port}${path}`)
		const text = await res.text()
		if (res.status !== status || text !== body) throw new Error(`${NAME} ${path}: HTTP ${res.status} ${text}; want ${status} ${body}`)
	}
	if (proxy.connects.join() !== [`${host}:443`, `${host}:443`].join())
		throw new Error(`${NAME}: the operator's ASP was asked [${proxy.connects}]; want the root once and the public key once`)
	console.log(`ok   ${NAME}: pool1's ASP is ${host}, asked once per URL, and never for note events`)
}

/** No client header goes up, the app's User-Agent does, and no upstream header comes back. */
async function assertIsolated(port: number, fake: Fake, path: string, upstreamPath: string): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: CLIENT_HEADERS })
	await res.arrayBuffer()
	const up = fake.seen.at(-1)
	const leaked = Object.keys(CLIENT_HEADERS).filter((name) => up?.headers[name] !== undefined)
	const back = ["set-cookie", "x-upstream"].filter((name) => res.headers.has(name))
	if (res.status !== 200 || up?.url !== upstreamPath || up.headers["user-agent"] !== USER_AGENT || leaked.length > 0 || back.length > 0)
		throw new Error(
			`${NAME} ${path}: HTTP ${res.status}, user-agent ${up?.headers["user-agent"]}; client headers upstream: [${leaked}]; upstream headers back: [${back}]`,
		)
	console.log(`ok   ${NAME} ${path}: only the app's User-Agent goes up and no upstream header comes back`)
}

async function assertUpstreamDown(port: number, bot: Fake): Promise<void> {
	await bot.close()
	const res = await fetch(`http://127.0.0.1:${port}/bot/v1/snapshots/latest`)
	const body = await res.text()
	if (res.status !== 502 || body !== UPSTREAM_DOWN.bot) throw new Error(`${NAME}: a dead bot gave HTTP ${res.status}: ${body}`)
	console.log(`ok   ${NAME}: a dead bot is HTTP 502 with its fixed text`)
}

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

type Start = { deployment?: string; host?: string; env?: NodeJS.ProcessEnv }
function startServe(outDir: string, port: number, o: Start): Group {
	const args = ["serve", "--outDir", outDir, "--host", o.host ?? "127.0.0.1", "--port", String(port), "--strictPort"]
	if (o.deployment !== undefined) args.push("--deployment", o.deployment)
	return bunRun(args, { env: { ...envWithout(), PP_CIRCUITS_DIR: process.env.PP_CIRCUITS_DIR, ...o.env }, capture: true })
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
		await assertRefusal(startServe(copy, port, { deployment }), port, `${NAME}, a stale ${file}`, reason)
	} finally {
		rmSync(copy, { recursive: true, force: true })
	}
}

async function assertRefusesToStart(outDir: string, port: number, deployment: string): Promise<void> {
	await assertRefusal(startServe(outDir, port, {}), port, "serve without --deployment over a testnet build", "is a testnet build")
	await assertRefusal(startServe(outDir, port, { deployment, host: "0.0.0.0" }), port, `${NAME} --host 0.0.0.0`, "binds 127.0.0.1 only")
	const target = testnetTarget(deployment, {}, await sponsoredFpcAddress())
	const receipt = { ...target, rollupVersion: (target.rollupVersion ?? 0) + 1 }
	await assertStale(outDir, port, deployment, TARGET_FILE, receipt, "is not the testnet build")
	const headers = securityHeaders({ ...target, l1RpcUrl: "https://rpc.example" })
	await assertStale(outDir, port, deployment, HEADER_FILE, headers, "is not the header set")
}

/** Every spelling of the proxy, and no inherited exemption: only the server's own bypass may keep loopback off it. */
const viaProxy = (port: number): NodeJS.ProcessEnv => {
	const url = `http://127.0.0.1:${port}`
	return { HTTP_PROXY: url, http_proxy: url, HTTPS_PROXY: url, https_proxy: url, NO_PROXY: "", no_proxy: "" }
}

async function assertServing(outDir: string, port: number, deployment: string, up: Upstreams, proxy: Fake): Promise<void> {
	const d = readTestnetDeployment(deployment)
	const [chain, e] = [d.network.l1ChainId, d.pool.entrypoint]
	const headers = JSON.parse(readFileSync(join(outDir, HEADER_FILE), "utf8")) as SecurityHeaders
	const g = startServe(outDir, port, { deployment, env: { ...viaProxy(proxy.port) } })
	try {
		await untilUp(NAME, port, g)
		for (const path of ["/", "/no/such/route", "/asp/no/such/route"]) await assertServed(NAME, port, path, headers)
		await assertRefused(port, up.asp?.port ?? proxy.port, chain, e, [up.bot, ...(up.asp ? [up.asp] : []), proxy])
		await assertForwarded(port, headers, up, chain, e)
		if (up.asp) await assertIsolated(port, up.asp, "/asp/public-key", "/public-key")
		else await assertIsolated(port, up.bot, "/bot/v1/snapshots/latest", "/v1/snapshots/latest")
		if (!up.asp) await assertOperator(port, proxy, chain, e)
		await assertCircuitFiles(port, d.bundle)
		await assertUpstreamDown(port, up.bot)
		if (proxy.seen.length > 0 || (up.asp && proxy.connects.length > 0))
			throw new Error(
				`${NAME}: loopback forwards went through the proxy (${[...proxy.seen.map((s) => s.url), ...proxy.connects].join(", ")})`,
			)
		console.log(`ok   ${NAME}: with the proxy variables set, every loopback forward went straight to its upstream`)
	} finally {
		await g.stop()
	}
}

/** @throws on the first check that fails; every server, claim and directory it took is released either way. */
export async function checkTestnet(file: string, outDir: string): Promise<void> {
	await loadTestnetServing(file, outDir)
	console.log(`ok   ${outDir} is the testnet build for ${file}, with the canonical SponsoredFPC`)
	const undo: (() => unknown)[] = []
	const claim = async (service: string) => {
		const c = await claimPort(service)
		undo.push(() => c.release())
		return c.port
	}
	const held = async (fake: Promise<Fake>) => {
		const f = await fake
		undo.push(() => f.close())
		return f
	}
	let clean = false
	try {
		const [port, bot, asp] = [await claim("headers"), await claim("headers-bot"), await claim("headers-asp")]
		const work = scratchDir("headers-testnet")
		undo.push(() => rmSync(work, { recursive: true, force: true }))
		const deployment = withUpstreams(file, work, bot, asp)
		const own = readTestnetDeployment(file).target === "own"
		const up = { bot: await held(listen(bot, upstreamAnswer)), asp: own ? await held(listen(asp, upstreamAnswer)) : null }
		const proxy = await held(listen(0, (_req, res) => res.writeHead(502).end()))
		await assertServing(outDir, port, deployment, up, proxy)
		await assertRefusesToStart(outDir, port, deployment)
	} finally {
		clean = await releaseAll(undo)
	}
	if (!clean) throw new Error("test:headers --target: the checks passed, but a teardown step failed (above)")
	console.log("test:headers --target passed")
}
