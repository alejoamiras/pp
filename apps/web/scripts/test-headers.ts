/**
 * The preview the e2e kit runs, checked from outside: its exact command (no `--config`, only
 * `PP_SANDBOX_ARTIFACTS` in the environment) over `dist/` must answer `/`, an asset and an unknown
 * route with exactly the build's header set, and over a copy whose `security-headers.json` is missing,
 * malformed or incomplete it must refuse to start. Run after `bun run build`.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"
import { HEADER_FILE, parseHeaderFile, type SecurityHeaders } from "../src/build/headers.ts"
import { claimPort } from "./ports"
import { APP_ROOT, bunRun, envWithout, type Group, scratchDir } from "./proc"

const DIST = join(APP_ROOT, "dist")
const START_TIMEOUT_MS = 30_000
const ARTIFACTS = dirname(resolvePackageAsset("@pp/e2e-kit", "fixtures/build-artifacts/handle.json", { from: import.meta.url }))

function preview(outDir: string, port: number): Group {
	const env = { ...envWithout(), PP_SANDBOX_ARTIFACTS: ARTIFACTS }
	return bunRun(["vite", "preview", "--outDir", outDir, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		env,
		capture: true,
	})
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
async function untilUp(port: number, g: Group): Promise<void> {
	let exited = false
	void g.exited.then(() => {
		exited = true
	})
	const deadline = Date.now() + START_TIMEOUT_MS
	while (Date.now() < deadline) {
		if (exited) throw new Error(`preview exited before answering:\n${g.output()}`)
		if (await answers(port)) return
		await sleep(200)
	}
	throw new Error(`preview did not answer within ${START_TIMEOUT_MS} ms:\n${g.output()}`)
}

async function assertServed(port: number, path: string, expected: SecurityHeaders): Promise<void> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "text/html,*/*" } })
	await res.arrayBuffer()
	const wrong = Object.entries(expected).filter(([name, value]) => res.headers.get(name) !== value)
	if (wrong.length > 0) throw new Error(`${path} (HTTP ${res.status}): wrong or missing ${wrong.map(([n]) => n).join(", ")}`)
	console.log(`ok   ${path} (HTTP ${res.status}) carries all ${Object.keys(expected).length} headers`)
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

async function assertRefuses(port: number, kind: string, breakFile: (file: string) => void): Promise<void> {
	const copy = scratchDir(`headers-${kind}`)
	cpSync(DIST, copy, { recursive: true })
	breakFile(join(copy, HEADER_FILE))
	const g = preview(copy, port)
	try {
		const code = await Promise.race([g.exited, sleep(START_TIMEOUT_MS, "timeout" as const, { ref: false })])
		if (code === 0 || code === "timeout") throw new Error(`preview with a ${kind} ${HEADER_FILE} did not fail to start (${code})`)
		if (await answers(port)) throw new Error(`preview with a ${kind} ${HEADER_FILE} still answers on :${port}`)
		if (!g.output().includes(HEADER_FILE)) throw new Error(`preview failed for another reason:\n${g.output()}`)
		console.log(`ok   ${kind} ${HEADER_FILE}: preview refuses to start (exit ${code})`)
	} finally {
		await g.stop()
		rmSync(copy, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	if (!existsSync(join(DIST, HEADER_FILE))) throw new Error(`no ${HEADER_FILE} in ${DIST}: run \`bun run build\` first`)
	const expected = parseHeaderFile(readFileSync(join(DIST, HEADER_FILE), "utf8"))
	const asset = readdirSync(join(DIST, "assets")).find((f) => f.endsWith(".js"))
	if (!asset) throw new Error(`no script under ${DIST}/assets`)
	const { port, release } = await claimPort("headers")
	try {
		const g = preview(DIST, port)
		try {
			await untilUp(port, g)
			for (const path of ["/", `/assets/${asset}`, "/no/such/route"]) await assertServed(port, path, expected)
		} finally {
			await g.stop()
		}
		for (const [kind, breakFile] of Object.entries(BROKEN)) await assertRefuses(port, kind, breakFile)
	} finally {
		await release()
	}
	console.log("test:headers passed")
}

await main()
