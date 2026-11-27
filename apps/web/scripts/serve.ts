/**
 * The app's own server for a built `dist/`: every answer carries the build's `security-headers.json`
 * (a missing or invalid one stops it before it listens), unknown routes fall back to `index.html`, and
 * `/<cid>` serves the three proving files of the one circuit the app proves, so pool-client's artifact
 * gateway is the page's own origin; other pinned circuits' files answer as unknown routes.
 * Those files are read only from `PP_CIRCUITS_DIR` (the pool checkout's circuit builds, which the e2e
 * kit takes from the local stack's CLI) and checked against the pinned manifest before the first byte
 * leaves; they are GPL and never part of a build. It refuses to start unless that names an absolute
 * directory; a directory without the files answers 503 on their routes and serves everything else.
 *
 * With `--deployment <file>` (a testnet build) it also proxies the ASP bot and the pool's mock ASP under
 * `/bot/` and `/asp/` (see `proxy.ts`). It then binds 127.0.0.1 only, refuses a build that is not the
 * one for that file, and answers only a Host of `localhost:<port>` or `127.0.0.1:<port>`, so a page
 * that points its own name at the forwarded port reads nothing. `--claim` registers the port in the
 * host registry for as long as the server runs.
 *
 * Usage: PP_CIRCUITS_DIR=<dir> bun scripts/serve.ts [--outDir dist] [--host 127.0.0.1] --port <n> [--strictPort]
 *   [--deployment <file> [--claim]]
 * (the port is always strict: a taken port is an error, never another port).
 */
import { readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createArtifacts } from "@pp/pool-client/circuits"
import { claimRows, releaseRows } from "@pp/run-isolation/ports"
import { HEADER_FILE, parseHeaderFile, type SecurityHeaders } from "../src/build/headers.ts"
import { PROVED_CIRCUIT, PROVED_PINS } from "../src/data/adapters/circuit.ts"
import { APP_ROOT } from "./proc"
import { forward, isProxyPath, type ProxyConfig, proxyRoute, type Upstream } from "./proxy"
import { loadTestnetServing } from "./testnet-serve"

type Getter = "getWasm" | "getProvingKey" | "getVerificationKey"
const FILES = [
	["wasm", "getWasm"],
	["provingKey", "getProvingKey"],
	["verificationKey", "getVerificationKey"],
] as const

/** Each of the proved circuit's cids to the getter that yields its verified bytes. */
const PINNED: ReadonlyMap<string, { circuit: string; get: Getter }> = new Map(
	FILES.map(([file, get]) => [PROVED_PINS[file], { circuit: PROVED_CIRCUIT, get }] as const),
)

const TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
}

interface Reply {
	status: number
	type: string
	body: Uint8Array | string
	headers?: Readonly<Record<string, string>>
}

const text = (status: number, body: string): Reply => ({ status, type: TYPES[".txt"] as string, body })

function loadHeaders(outDir: string): SecurityHeaders {
	const file = join(outDir, HEADER_FILE)
	let text: string
	try {
		text = readFileSync(file, "utf8")
	} catch {
		throw new Error(`serve: ${file} is missing; serve only a build this app produced`)
	}
	try {
		return parseHeaderFile(text)
	} catch (err) {
		throw new Error(`serve: ${file}: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * `PP_CIRCUITS_DIR`, refused unless it names an absolute directory. There is no default: an empty or
 * relative value resolves against the working directory, and so would serve whatever tree that is.
 */
function circuitsDir(value: string | undefined): string {
	if (!value || !isAbsolute(value))
		throw new Error(
			`serve: PP_CIRCUITS_DIR must be the absolute path of the pool's circuit builds, got ${JSON.stringify(value ?? null)}`,
		)
	let directory = false
	try {
		directory = statSync(value).isDirectory()
	} catch {}
	if (!directory) throw new Error(`serve: PP_CIRCUITS_DIR ${value} is not a directory`)
	return value
}

/** Verified on first use and kept: the files are read only when a proving file is asked for. */
let artifacts: ReturnType<typeof createArtifacts> | null = null
async function pinnedReply(cid: string, entry: { circuit: string; get: Getter }, circuits: string): Promise<Reply> {
	try {
		artifacts ??= createArtifacts({ kind: "dir", path: circuits })
		return { status: 200, type: "application/octet-stream", body: await artifacts[entry.get](entry.circuit) }
	} catch (err) {
		console.error(`serve: ${cid}: ${err instanceof Error ? err.message : String(err)}`)
		return text(503, "proving files unavailable")
	}
}

/**
 * The file under `outDir` a path names, or `null`; `/` names `index.html` whatever the request accepts.
 * Nothing outside `outDir` is ever read.
 */
function distFile(outDir: string, pathname: string): string | null {
	let rel: string
	try {
		rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "")
	} catch {
		return null
	}
	const path = resolve(outDir, rel === "" ? "index.html" : rel)
	const inside = relative(outDir, path)
	if (inside.startsWith("..") || isAbsolute(inside)) return null
	try {
		return statSync(path).isFile() ? path : null
	} catch {
		return null
	}
}

const fileReply = (path: string): Reply => ({
	status: 200,
	type: TYPES[extname(path)] ?? "application/octet-stream",
	body: readFileSync(path),
})

const UPSTREAM_DOWN: Readonly<Record<Upstream, string>> = {
	asp: "the pool's ASP does not answer",
	bot: "the ASP bot does not answer",
}

async function proxied(method: string | undefined, rawTarget: string, config: ProxyConfig): Promise<Reply> {
	if (method !== "GET") return text(405, "method not allowed")
	const route = proxyRoute(rawTarget, config)
	if (route === null) return text(404, "not found")
	const r = await forward(route.url)
	if (r.ok) return { status: r.status, type: TYPES[".json"] as string, body: r.body, headers: { "Cache-Control": "no-store" } }
	console.error(`serve: ${route.upstream}: ${r.reason}`)
	return text(502, UPSTREAM_DOWN[route.upstream])
}

interface Testnet {
	readonly proxy: ProxyConfig
	/** The exact Host values this server answers. */
	readonly hosts: ReadonlySet<string>
}

/** The request's one Host value, or `null` when it sends none or several. */
function hostOf(req: IncomingMessage): string | null {
	const values: string[] = []
	for (let i = 0; i < req.rawHeaders.length; i += 2)
		if (req.rawHeaders[i]?.toLowerCase() === "host") values.push(req.rawHeaders[i + 1] ?? "")
	return values.length === 1 ? (values[0] as string) : null
}

async function reply(req: IncomingMessage, outDir: string, circuits: string, testnet: Testnet | null): Promise<Reply> {
	if (testnet) {
		const host = hostOf(req)
		if (host === null || !testnet.hosts.has(host)) return text(421, "misdirected request")
		if (isProxyPath(req.url ?? "/")) return proxied(req.method, req.url ?? "/", testnet.proxy)
	}
	if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed")
	const pathname = new URL(req.url ?? "/", "http://serve.invalid").pathname
	const pinned = PINNED.get(pathname.slice(1))
	if (pinned) return pinnedReply(pathname.slice(1), pinned, circuits)
	const file = distFile(outDir, pathname)
	if (file) return fileReply(file)
	if ((req.headers.accept ?? "").includes("text/html")) return fileReply(join(outDir, "index.html"))
	return text(404, "not found")
}

/** The testnet state for `--deployment`, or `null` without one. */
async function testnetFor(file: string | undefined, outDir: string, host: string, port: number): Promise<Testnet | null> {
	if (file === undefined) return null
	if (host !== "127.0.0.1") throw new Error(`serve: --deployment binds 127.0.0.1 only, got --host ${host}`)
	const { proxy } = await loadTestnetServing(resolve(file), outDir)
	return { proxy, hosts: new Set([`localhost:${port}`, `127.0.0.1:${port}`]) }
}

/**
 * Registers `port` under a fresh run id and returns its release. The registry never reaps a dead
 * owner's rows, so a hard kill leaves this one until it is released by the printed run id.
 */
async function claim(port: number): Promise<() => Promise<void>> {
	const runId = `web-testnet-${process.pid}-${Date.now().toString(36)}`
	await claimRows(runId, { "web-testnet": port }, process.pid)
	console.log(`serve: claimed port ${port} as ${runId}`)
	return async () => void (await releaseRows(runId))
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			outDir: { type: "string" },
			host: { type: "string" },
			port: { type: "string" },
			strictPort: { type: "boolean" },
			deployment: { type: "string" },
			claim: { type: "boolean" },
		},
	})
	const outDir = resolve(APP_ROOT, values.outDir ?? "dist")
	const host = values.host ?? "127.0.0.1"
	const port = Number(values.port)
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("serve: --port takes a port number")
	if (values.claim && values.deployment === undefined) throw new Error("serve: --claim goes with --deployment")
	const circuits = circuitsDir(process.env.PP_CIRCUITS_DIR)
	const headers = loadHeaders(outDir)
	const testnet = await testnetFor(values.deployment, outDir, host, port)
	const release = values.claim ? await claim(port) : async () => {}
	const stop = (code: number) => void release().finally(() => process.exit(code))
	if (values.claim) for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop(0))
	const server = createServer((req, res) => {
		void reply(req, outDir, circuits, testnet)
			.catch((): Reply => text(500, "internal error"))
			.then((r) => {
				res.writeHead(r.status, { ...headers, ...r.headers, "Content-Type": r.type, "Content-Length": Buffer.byteLength(r.body) })
				res.end(req.method === "HEAD" ? undefined : r.body)
			})
	})
	server.once("error", (err) => {
		console.error(`serve: ${host}:${port}: ${err.message}`)
		stop(1)
	})
	server.listen(port, host, () => console.log(`serving ${outDir} at http://${host}:${port}`))
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
})
