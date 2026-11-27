/**
 * The two servers the e2e kit runs, checked from outside: the preview by its exact command (no
 * `--config`, only `PP_SANDBOX_ARTIFACTS` in the environment) and the app's own `serve`. Over `dist/`
 * each must answer `/`, an asset and an unknown route (and `serve` each pinned proving file's route,
 * served or 503 without a checkout) with exactly the build's header set, and over a copy whose
 * `security-headers.json` is missing, malformed, incomplete or weakened it must refuse to start. Run
 * after `bun run build`.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"
import { PINNED_CIRCUITS } from "@pp/pool-client/circuits"
import { HEADER_FILE, parseHeaderFile, type SecurityHeaders } from "../src/build/headers.ts"
import { claimPort } from "./ports"
import { APP_ROOT, bunRun, envWithout, type Group, scratchDir } from "./proc"

const DIST = join(APP_ROOT, "dist")
const START_TIMEOUT_MS = 30_000
const ARTIFACTS = dirname(resolvePackageAsset("@pp/e2e-kit", "fixtures/build-artifacts/handle.json", { from: import.meta.url }))
const PINNED_PATHS = Object.values(PINNED_CIRCUITS).flatMap((p) => [p.wasm, p.provingKey, p.verificationKey].map((cid) => `/${cid}`))

interface Server {
	start(outDir: string, port: number): Group
	/** Routes beyond the shared ones that must carry the headers. */
	extraPaths: readonly string[]
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
	},
	serve: {
		start: (outDir, port) => bunRun(["serve", "--outDir", outDir, ...host(port)], { env: envWithout(), capture: true }),
		extraPaths: PINNED_PATHS,
	},
}

async function answers(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) })
		return true
	} catch {
		return false
	}
}

/** Resolves once the server answers; rejects if it exits or stays silent past the timeout. */
async function untilUp(name: string, port: number, g: Group): Promise<void> {
	let exited = false
	void g.exited.then(() => {
		exited = true
	})
	const deadline = Date.now() + START_TIMEOUT_MS
	while (Date.now() < deadline) {
		if (exited) throw new Error(`${name} exited before answering:\n${g.output()}`)
		if (await answers(port)) return
		await sleep(200)
	}
	throw new Error(`${name} did not answer within ${START_TIMEOUT_MS} ms:\n${g.output()}`)
}

async function assertServed(name: string, port: number, path: string, expected: SecurityHeaders): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "text/html,*/*" } })
	await res.arrayBuffer()
	const wrong = Object.entries(expected).filter(([header, value]) => res.headers.get(header) !== value)
	if (wrong.length > 0) throw new Error(`${name} ${path} (HTTP ${res.status}): wrong or missing ${wrong.map(([n]) => n).join(", ")}`)
	console.log(`ok   ${name} ${path} (HTTP ${res.status}) carries all ${Object.keys(expected).length} headers`)
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
	cpSync(DIST, copy, { recursive: true })
	breakFile(join(copy, HEADER_FILE))
	const g = server.start(copy, port)
	try {
		const code = await Promise.race([g.exited, sleep(START_TIMEOUT_MS, "timeout" as const, { ref: false })])
		if (code === 0 || code === "timeout") throw new Error(`${name} with a ${kind} ${HEADER_FILE} did not fail to start (${code})`)
		if (await answers(port)) throw new Error(`${name} with a ${kind} ${HEADER_FILE} still answers on :${port}`)
		if (!g.output().includes(HEADER_FILE)) throw new Error(`${name} failed for another reason:\n${g.output()}`)
		console.log(`ok   ${name}, ${kind} ${HEADER_FILE}: refuses to start (exit ${code})`)
	} finally {
		await g.stop()
		rmSync(copy, { recursive: true, force: true })
	}
}

async function assertServer(name: string, server: Server, port: number, expected: SecurityHeaders, asset: string): Promise<void> {
	const g = server.start(DIST, port)
	try {
		await untilUp(name, port, g)
		for (const path of ["/", `/assets/${asset}`, "/no/such/route", ...server.extraPaths]) await assertServed(name, port, path, expected)
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
	} finally {
		await release()
	}
	console.log("test:headers passed")
}

await main()
