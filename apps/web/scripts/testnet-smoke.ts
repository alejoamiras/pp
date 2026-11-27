/**
 * A testnet build in Chromium behind `serve --deployment`, opened at `http://localhost:<port>/` as the
 * owner opens it, reading the node, the L1 RPC and the proxied services from the page. Under
 * `--no-upstreams` the file's upstream ports are claimed ones nothing serves and `PP_CIRCUITS_DIR` is
 * an empty scratch directory; live, both come from the host.
 *
 * Usage: [PP_CIRCUITS_DIR=<dir>] bun scripts/testnet-smoke.ts --target <file> [--outDir dist-testnet] [--no-upstreams]
 */
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import { type BrowserContext, chromium, type Page } from "@playwright/test"
import { readTestnetDeployment } from "../src/build/testnet.ts"
import { claimPort } from "./ports"
import { APP_ROOT, bunRun, envWithout, scratchDir } from "./proc"
import { type Upstream, UPSTREAM_DOWN } from "./proxy"
import { untilUp } from "./served"
import { withUpstreams } from "./test-headers-testnet"

const SEPOLIA = "0xaa36a7"
const SETTLE_MS = 15_000
const RENDER_MS = 60_000
type Deployment = ReturnType<typeof readTestnetDeployment>

/**
 * Refuses any request off `allowed` (`data:` and `blob:` never leave the page) and records it in
 * `refused`; `made` counts the rest by origin. `route` sees only a request's first hop, so blocking
 * happens there and recording on `request`, which every redirect hop raises.
 */
async function fence(context: BrowserContext, allowed: ReadonlySet<string>): Promise<{ refused: string[]; made: Map<string, number> }> {
	const refused: string[] = []
	const made = new Map<string, number>()
	const permitted = (url: URL) => url.protocol === "data:" || url.protocol === "blob:" || allowed.has(url.origin)
	context.on("request", (request) => {
		const url = new URL(request.url())
		if (!permitted(url)) refused.push(url.href)
		else if (/^https?:$/.test(url.protocol)) made.set(url.origin, (made.get(url.origin) ?? 0) + 1)
	})
	await context.route("**/*", (route) => (permitted(new URL(route.request().url())) ? route.continue() : route.abort("blockedbyclient")))
	await context.routeWebSocket(/.*/, (ws) => {
		refused.push(ws.url())
		return ws.close({ code: 1008, reason: "not an allowed origin" })
	})
	return { refused, made }
}

/** A JSON-RPC call made by the page itself, so CORS, COEP and the CSP all apply. */
function rpcFromPage(page: Page, url: string, method: string): Promise<unknown> {
	return page.evaluate(
		async ([url, method]) => {
			const res = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
				redirect: "error",
			})
			const body = (await res.json()) as { result?: unknown; error?: unknown }
			if (!res.ok || body.error !== undefined) throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(body.error)}`)
			return body.result
		},
		[url, method] as const,
	)
}

/** The public endpoints rate-limit; a 429 is retried twice, any other failure fails at once. */
async function rpc(page: Page, url: string, method: string): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await rpcFromPage(page, url, method)
		} catch (err) {
			if (attempt === 3 || !String(err).includes("HTTP 429")) throw err
			await sleep(2_000 * attempt)
		}
	}
}

function getFromPage(page: Page, path: string): Promise<{ status: number; text: string }> {
	return page.evaluate(async (path) => {
		const res = await fetch(path, { redirect: "error" })
		return { status: res.status, text: await res.text() }
	}, path)
}

/**
 * The app itself ran: live, its header; offline, where the fixture's made-up contracts cannot be read,
 * its header or its deployment alert. A page whose script never ran shows neither.
 */
async function assertRendered(page: Page, offline: boolean): Promise<void> {
	const heading = page.getByRole("heading", { name: "Label bridge" })
	const alert = page.getByRole("alert").filter({ hasText: "could not read the deployment" })
	await (offline ? heading.or(alert) : heading).first().waitFor({ timeout: RENDER_MS })
	console.log(`ok   the app rendered ${(await heading.isVisible()) ? "its header" : "its deployment alert"}`)
}

async function assertChains(page: Page, d: Deployment): Promise<void> {
	const info = (await rpc(page, d.network.aztecNode, "node_getNodeInfo")) as { l1ChainId?: unknown; rollupVersion?: unknown }
	if (Number(info.l1ChainId) !== d.network.l1ChainId || Number(info.rollupVersion) !== d.network.rollupVersion)
		throw new Error(
			`the node reports chain ${info.l1ChainId}, rollup ${info.rollupVersion}; the file pins ${d.network.l1ChainId}, ${d.network.rollupVersion}`,
		)
	console.log(`ok   node_getNodeInfo from the page: chain ${d.network.l1ChainId}, rollup version ${d.network.rollupVersion}`)
	const chain = await rpc(page, d.network.l1Rpc, "eth_chainId")
	if (chain !== SEPOLIA) throw new Error(`eth_chainId from the page is ${String(chain)}, not ${SEPOLIA}`)
	console.log(`ok   eth_chainId from the page: ${SEPOLIA}`)
}

async function assertReads(page: Page, d: Deployment, offline: boolean): Promise<void> {
	const q = `chainId=${d.network.l1ChainId}&entrypoint=${d.pool.entrypoint}`
	const reads: [Upstream, string][] = [
		["bot", "/bot/v1/snapshots/latest"],
		["asp", `/asp/association-set/root?${q}`],
		["asp", `/asp/association-set/leaves?${q}`],
		["asp", `/asp/${d.network.l1ChainId}/public/event-snapshot/payload?entrypoint=${d.pool.entrypoint}`],
	]
	for (const [upstream, path] of reads) {
		const { status, text } = await getFromPage(page, path)
		const ok = offline ? status === 502 && text === UPSTREAM_DOWN[upstream] : status === 200
		if (!ok) throw new Error(`GET ${path} from the page: HTTP ${status} ${text.slice(0, 200)}`)
		console.log(`ok   GET ${path} from the page: HTTP ${status}${offline ? `, "${text}"` : `, ${text.length} bytes`}`)
	}
}

async function smoke(port: number, d: Deployment, offline: boolean): Promise<void> {
	const origin = `http://localhost:${port}`
	const browser = await chromium.launch({ headless: true })
	try {
		const context = await browser.newContext({ serviceWorkers: "block" })
		const { refused, made } = await fence(
			context,
			new Set([origin, new URL(d.network.aztecNode).origin, new URL(d.network.l1Rpc).origin]),
		)
		const page = await context.newPage()
		const problems: string[] = []
		page.on("pageerror", (err) => problems.push(`page error: ${err.message}`))
		page.on("console", (m) => {
			if (/Content Security Policy/i.test(m.text())) problems.push(`CSP: ${m.text()}`)
		})
		const nav = await page.goto(`${origin}/`, { waitUntil: "load" })
		if (!nav?.ok()) throw new Error(`${origin}/ answered HTTP ${nav?.status()}`)
		await assertRendered(page, offline)
		await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => {})
		if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error(`${origin}/ is not cross-origin isolated`)
		console.log(`ok   ${origin}/ is cross-origin isolated`)
		await assertChains(page, d)
		await assertReads(page, d, offline)
		if (problems.length > 0) throw new Error(`the page reported:\n${problems.join("\n")}`)
		if (refused.length > 0) throw new Error(`the page asked for other origins:\n${refused.join("\n")}`)
		console.log("ok   no CSP violation, no page error, no request beyond the page, the node and the L1 RPC")
		console.log(`     requests: ${[...made].map(([o, n]) => `${o} ×${n}`).join(", ")}`)
	} finally {
		await browser.close()
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { target: { type: "string" }, outDir: { type: "string" }, "no-upstreams": { type: "boolean" } },
	})
	if (values.target === undefined) throw new Error("testnet-smoke: --target <deployment file> is required")
	const offline = values["no-upstreams"] === true
	const undo: (() => unknown)[] = []
	const claim = async (service: string) => {
		const c = await claimPort(service)
		undo.push(() => c.release())
		return c.port
	}
	try {
		const port = await claim("smoke")
		const work = scratchDir("testnet-smoke")
		undo.push(() => rmSync(work, { recursive: true, force: true }))
		let deployment = resolve(values.target)
		let circuits = process.env.PP_CIRCUITS_DIR
		if (offline) {
			deployment = withUpstreams(deployment, work, await claim("smoke-bot"), await claim("smoke-asp"))
			circuits = join(work, "circuits")
			mkdirSync(circuits)
		}
		const outDir = resolve(APP_ROOT, values.outDir ?? "dist-testnet")
		const args = [
			"serve",
			"--outDir",
			outDir,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--strictPort",
			"--deployment",
			deployment,
		]
		const g = bunRun(args, { env: { ...envWithout(), PP_CIRCUITS_DIR: circuits }, capture: true })
		undo.push(() => g.stop())
		await untilUp("serve --deployment", port, g)
		await smoke(port, readTestnetDeployment(deployment), offline).catch((err: unknown) => {
			// A 502's cause is in the server's log alone.
			throw new Error(`${err instanceof Error ? err.message : String(err)}\nserve's log:\n${g.output()}`)
		})
	} finally {
		for (const step of undo.reverse()) await step()
	}
	console.log(`test:testnet-smoke passed${offline ? " (no upstreams)" : ""}`)
}

await main()
