/**
 * The app's own server for a built `dist/`: every answer carries the build's `security-headers.json`
 * (a missing or invalid one stops it before it listens), unknown routes fall back to `index.html`, and
 * `/<cid>` serves the pinned proving files, so pool-client's artifact gateway is the page's own origin.
 * Those files are read only from `PP_CIRCUITS_DIR` (the pool checkout's circuit builds, which the e2e
 * kit takes from the local stack's CLI) and checked against the pinned manifest before the first byte
 * leaves; they are GPL and never part of a build. It refuses to start unless that names an absolute
 * directory; a directory without the files answers 503 on their routes and serves everything else.
 *
 * Usage: PP_CIRCUITS_DIR=<dir> bun scripts/serve.ts [--outDir dist] [--host 127.0.0.1] --port <n> [--strictPort]
 * (the port is always strict: a taken port is an error, never another port).
 */
import { readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { createArtifacts, PINNED_CIRCUITS } from "@pp/pool-client/circuits"
import { HEADER_FILE, parseHeaderFile, type SecurityHeaders } from "../src/build/headers.ts"
import { APP_ROOT } from "./proc"

type Getter = "getWasm" | "getProvingKey" | "getVerificationKey"
const FILES = [
	["wasm", "getWasm"],
	["provingKey", "getProvingKey"],
	["verificationKey", "getVerificationKey"],
] as const

/** Each pinned cid to the circuit and getter that yield its verified bytes. */
const PINNED: ReadonlyMap<string, { circuit: string; get: Getter }> = new Map(
	Object.entries(PINNED_CIRCUITS).flatMap(([circuit, pin]) => FILES.map(([file, get]) => [pin[file], { circuit, get }] as const)),
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

/** The file under `outDir` a path names, or `null`; nothing outside `outDir` is ever read. */
function distFile(outDir: string, pathname: string): string | null {
	let rel: string
	try {
		rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "")
	} catch {
		return null
	}
	const path = resolve(outDir, rel)
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

async function reply(req: IncomingMessage, outDir: string, circuits: string): Promise<Reply> {
	if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed")
	const pathname = new URL(req.url ?? "/", "http://serve.invalid").pathname
	const pinned = PINNED.get(pathname.slice(1))
	if (pinned) return pinnedReply(pathname.slice(1), pinned, circuits)
	const file = distFile(outDir, pathname)
	if (file) return fileReply(file)
	if ((req.headers.accept ?? "").includes("text/html")) return fileReply(join(outDir, "index.html"))
	return text(404, "not found")
}

function main(): void {
	const { values } = parseArgs({
		options: { outDir: { type: "string" }, host: { type: "string" }, port: { type: "string" }, strictPort: { type: "boolean" } },
	})
	const outDir = resolve(APP_ROOT, values.outDir ?? "dist")
	const host = values.host ?? "127.0.0.1"
	const port = Number(values.port)
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("serve: --port takes a port number")
	const circuits = circuitsDir(process.env.PP_CIRCUITS_DIR)
	const headers = loadHeaders(outDir)
	const server = createServer((req, res) => {
		void reply(req, outDir, circuits)
			.catch((): Reply => text(500, "internal error"))
			.then((r) => {
				res.writeHead(r.status, { ...headers, "Content-Type": r.type, "Content-Length": Buffer.byteLength(r.body) })
				res.end(req.method === "HEAD" ? undefined : r.body)
			})
	})
	server.once("error", (err) => {
		console.error(`serve: ${host}:${port}: ${err.message}`)
		process.exit(1)
	})
	server.listen(port, host, () => console.log(`serving ${outDir} at http://${host}:${port}`))
}

main()
