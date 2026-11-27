// Serves the built probe page and the pinned circuit files by CID, cross-origin isolated, on a claimed loopback port.
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { extname, join, normalize } from "node:path"
import { claimPort, releasePorts } from "../../../pp-env/src/env/harness/ports.ts"
import { PINNED_CIRCUITS } from "../../src/runtime/artifacts.ts"
import { circuitsDir, PACKAGE_DIR } from "../support/paths.ts"

const DIST = join(PACKAGE_DIR, "test/browser/dist")
const ISOLATION = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin",
}
const TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".wasm": "application/wasm",
	".json": "application/json",
}

/** `/ipfs/<cid>` serves the pinned bytes; `/tampered/<cid>` the same with one byte of the zkey flipped. */
function circuitFiles(): Map<string, { path: string; tamper: boolean }> {
	const files = new Map<string, { path: string; tamper: boolean }>()
	const pin = PINNED_CIRCUITS.transact_1x1!
	const dir = join(circuitsDir(), "transact_1x1")
	files.set(pin.wasm, { path: join(dir, "transact_1x1_js/transact_1x1.wasm"), tamper: false })
	files.set(pin.provingKey, { path: join(dir, "groth16_pkey.zkey"), tamper: true })
	files.set(pin.verificationKey, { path: join(dir, "groth16_vkey.json"), tamper: false })
	return files
}

function distFile(requested: string): [number, Buffer | undefined, string] {
	const rel = normalize(requested)
	if (rel.startsWith("..")) return [400, undefined, "text/plain"]
	try {
		return [200, readFileSync(join(DIST, rel)), TYPES[extname(rel)] ?? "application/octet-stream"]
	} catch {
		return [404, undefined, "text/plain"]
	}
}

export type PageServer = { url: string; stop(): Promise<void> }

export async function startPageServer(): Promise<PageServer> {
	const runId = `pool-client-page-${process.pid}-${Date.now()}`
	const files = circuitFiles()
	const port = await claimPort(runId, "pool-client-page")
	const server: Server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0]!
		const [, route = "", cid = ""] = path.split("/")
		const file = files.get(cid)
		if ((route === "ipfs" || route === "tampered") && file) {
			const bytes = readFileSync(file.path)
			if (route === "tampered" && file.tamper) bytes[bytes.length >> 1]! ^= 1
			return void res.writeHead(200, { ...ISOLATION, "Content-Type": "application/octet-stream" }).end(bytes)
		}
		const [status, body, type] = distFile(route === "" ? "index.html" : path.slice(1))
		res.writeHead(status, { ...ISOLATION, "Content-Type": type }).end(body)
	})
	try {
		await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve))
	} catch (err) {
		await releasePorts(runId)
		throw err
	}
	return {
		url: `http://127.0.0.1:${port}`,
		async stop() {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			await releasePorts(runId)
		},
	}
}
