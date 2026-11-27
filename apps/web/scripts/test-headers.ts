/**
 * The two servers the e2e kit runs, checked from outside: the preview by its exact command (no
 * `--config`, only `PP_SANDBOX_ARTIFACTS` in the environment) and the app's own `serve` (only
 * `PP_CIRCUITS_DIR`, an empty scratch directory). Over `dist/` each must answer `/`, an asset and an
 * unknown route (and `serve` the proved circuit's three file routes, 503 here without the files) with
 * exactly the build's header set, `/` with `index.html` whatever the request accepts, and over a copy whose `security-headers.json` is missing,
 * malformed, incomplete or weakened it must refuse to start. `serve` must also refuse with
 * `PP_CIRCUITS_DIR` unset, empty, relative or naming a file, and answer 404 for any other pinned circuit's
 * files. Run after `bun run build`.
 *
 * `--target <file> [--outDir dist-testnet]` checks `serve --deployment` over that file's testnet build
 * instead (`test-headers-testnet.ts`), with `PP_CIRCUITS_DIR` from the environment.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"
import { PINNED_CIRCUITS, type PinnedCircuit } from "@pp/pool-client/circuits"
import { HEADER_FILE, parseHeaderFile, type SecurityHeaders } from "../src/build/headers.ts"
import { PROVED_CIRCUIT, PROVED_PINS } from "../src/data/adapters/circuit.ts"
import { claimPort } from "./ports"
import { APP_ROOT, bunRun, envWithout, type Group, scratchDir } from "./proc"
import { assertRefusal, assertServed, untilUp } from "./served"
import { checkTestnet } from "./test-headers-testnet"

const DIST = join(APP_ROOT, "dist")
const ARTIFACTS = dirname(resolvePackageAsset("@pp/e2e-kit", "fixtures/build-artifacts/handle.json", { from: import.meta.url }))
const cidPaths = (p: PinnedCircuit) => [p.wasm, p.provingKey, p.verificationKey].map((cid) => `/${cid}`)
const PINNED_PATHS = cidPaths(PROVED_PINS)
/** Pinned files of circuits the app never proves: `serve` must not hand them out. */
const UNPROVED_PATHS = Object.entries(PINNED_CIRCUITS)
	.filter(([circuit]) => circuit !== PROVED_CIRCUIT)
	.flatMap(([, p]) => cidPaths(p))
/** Holds no proving files, so their routes answer 503: the headers are what this checks. */
const CIRCUITS = scratchDir("headers-circuits")

interface Server {
	start(outDir: string, port: number): Group
	/** Routes beyond the shared ones that must carry the headers. */
	extraPaths: readonly string[]
	/** Routes that must answer 404 to a request that does not accept text/html. */
	absentPaths: readonly string[]
}

const host = (port: number) => ["--host", "127.0.0.1", "--port", String(port), "--strictPort"]

const SERVERS: Record<string, Server> = {
	preview: {
		start: (outDir, port) =>
			bunRun(["vite", "preview", "--outDir", outDir, ...host(port)], {
				env: { ...envWithout(), PP_SANDBOX_ARTIFACTS: ARTIFACTS },
				capture: true,
			}),
		extraPaths: [],
		absentPaths: [],
	},
	serve: {
		start: (outDir, port) => startServe(outDir, port, { PP_CIRCUITS_DIR: CIRCUITS }),
		extraPaths: PINNED_PATHS,
		absentPaths: UNPROVED_PATHS,
	},
}

function startServe(outDir: string, port: number, env: NodeJS.ProcessEnv): Group {
	return bunRun(["serve", "--outDir", outDir, ...host(port)], { env: { ...envWithout(), ...env }, capture: true })
}

/** `/` is the app whatever the request accepts: curl, a bare fetch and health probes send no text/html. */
async function assertRoot(name: string, port: number): Promise<void> {
	const index = readFileSync(join(DIST, "index.html"), "utf8")
	for (const method of ["GET", "HEAD"] as const) {
		const res = await fetch(`http://127.0.0.1:${port}/`, { method, headers: { accept: "*/*" } })
		const body = await res.text()
		const html = res.headers.get("content-type")?.startsWith("text/html") === true
		if (res.status !== 200 || !html || (method === "GET" && body !== index))
			throw new Error(`${name} ${method} / without text/html: HTTP ${res.status}, ${res.headers.get("content-type")}, not index.html`)
		console.log(`ok   ${name} ${method} / without text/html serves index.html`)
	}
}

async function assertAbsent(name: string, port: number, path: string): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "*/*" } })
	await res.arrayBuffer()
	if (res.status !== 404) throw new Error(`${name} ${path}: HTTP ${res.status}, not 404`)
	console.log(`ok   ${name} ${path} is not served (HTTP 404)`)
}

const BROKEN: Record<string, (file: string) => void> = {
	missing: (file) => unlinkSync(file),
	malformed: (file) => writeFileSync(file, "{"),
	incomplete: (file) => {
		const { "Content-Security-Policy": _csp, ...rest } = parseHeaderFile(readFileSync(file, "utf8"))
		writeFileSync(file, JSON.stringify(rest))
	},
	weakened: (file) => {
		const headers = parseHeaderFile(readFileSync(file, "utf8"))
		writeFileSync(file, JSON.stringify({ ...headers, "Content-Security-Policy": "default-src 'none';" }))
	},
}

async function assertRefuses(name: string, server: Server, port: number, kind: string, breakFile: (file: string) => void): Promise<void> {
	const copy = scratchDir(`headers-${kind}`)
	try {
		cpSync(DIST, copy, { recursive: true })
		breakFile(join(copy, HEADER_FILE))
		await assertRefusal(server.start(copy, port), port, `${name}, ${kind} ${HEADER_FILE}`, HEADER_FILE)
	} finally {
		rmSync(copy, { recursive: true, force: true })
	}
}

/** An empty or relative value would resolve against the server's working directory and serve another tree. */
const BAD_CIRCUITS: Record<string, NodeJS.ProcessEnv> = {
	unset: {},
	empty: { PP_CIRCUITS_DIR: "" },
	relative: { PP_CIRCUITS_DIR: "circuits" },
	"a file": { PP_CIRCUITS_DIR: join(DIST, HEADER_FILE) },
}

async function assertServer(name: string, server: Server, port: number, expected: SecurityHeaders, asset: string): Promise<void> {
	const g = server.start(DIST, port)
	try {
		await untilUp(name, port, g)
		for (const path of ["/", `/assets/${asset}`, "/no/such/route", ...server.extraPaths]) await assertServed(name, port, path, expected)
		await assertRoot(name, port)
		for (const path of server.absentPaths) await assertAbsent(name, port, path)
	} finally {
		await g.stop()
	}
	for (const [kind, breakFile] of Object.entries(BROKEN)) await assertRefuses(name, server, port, kind, breakFile)
}

async function main(): Promise<void> {
	if (!existsSync(join(DIST, HEADER_FILE))) throw new Error(`no ${HEADER_FILE} in ${DIST}: run \`bun run build\` first`)
	const expected = parseHeaderFile(readFileSync(join(DIST, HEADER_FILE), "utf8"))
	const asset = readdirSync(join(DIST, "assets")).find((f) => f.endsWith(".js"))
	if (!asset) throw new Error(`no script under ${DIST}/assets`)
	const { port, release } = await claimPort("headers")
	try {
		for (const [name, server] of Object.entries(SERVERS)) await assertServer(name, server, port, expected, asset)
		for (const [kind, env] of Object.entries(BAD_CIRCUITS))
			await assertRefusal(startServe(DIST, port, env), port, `serve, PP_CIRCUITS_DIR ${kind}`, "PP_CIRCUITS_DIR")
	} finally {
		await release()
	}
	console.log("test:headers passed")
}

const { values } = parseArgs({ options: { target: { type: "string" }, outDir: { type: "string" } } })
try {
	if (values.target !== undefined) await checkTestnet(resolve(values.target), resolve(APP_ROOT, values.outDir ?? "dist-testnet"))
	else if (values.outDir !== undefined) throw new Error("--outDir goes with --target")
	else await main()
} finally {
	rmSync(CIRCUITS, { recursive: true, force: true })
}
