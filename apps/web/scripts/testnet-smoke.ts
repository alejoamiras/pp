/**
 * A testnet build in Chromium behind `serve --deployment`, opened at `http://localhost:<port>/` as the
 * owner opens it. The page must be cross-origin isolated with no CSP violation and no page error, and
 * request nothing but its own origin, the node and the L1 RPC (anything else is refused and reported).
 * From the page, the node must report the file's chain and rollup version and the L1 RPC Sepolia, and
 * each proxied read the app makes must answer 200 (its size is logged) or, under `--no-upstreams`,
 * 502 with its fixed text. There the file's upstream ports are claimed ones nothing serves and
 * `PP_CIRCUITS_DIR` is an empty scratch directory; live, both come from the host.
 *
 * Usage: [PP_CIRCUITS_DIR=<dir>] bun scripts/testnet-smoke.ts --target <file> [--outDir dist-testnet] [--no-upstreams]
 */
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
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

/**
 * Every request the context makes off `allowed` is refused and recorded; `data:` and `blob:` never
 * leave the page. `made` counts the rest by origin.
 */
async function fence(context: BrowserContext, allowed: ReadonlySet<string>): Promise<{ refused: string[]; made: Map<string, number> }> {
	const refused: string[] = []
	const made = new Map<string, number>()
	const permitted = (url: URL) => url.protocol === "data:" || url.protocol === "blob:" || allowed.has(url.origin)
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url())
		if (permitted(url)) {
			if (/^https?:$/.test(url.protocol)) made.set(url.origin, (made.get(url.origin) ?? 0) + 1)
			return route.continue()
		}
		refused.push(url.href)
		return route.abort("blockedbyclient")
	})
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
			})
			const body = (await res.json()) as { result?: unknown; error?: unknown }
			if (!res.ok || body.error !== undefined) throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(body.error)}`)
			return body.result
		},
		[url, method] as const,
	)
}

function getFromPage(page: Page, path: string): Promise<{ status: number; text: string }> {
	return page.evaluate(async (path) => {
		const res = await fetch(path)
		return { status: res.status, text: await res.text() }
	}, path)
}

async function assertChains(page: Page, d: ReturnType<typeof readTestnetDeployment>): Promise<void> {
	const info = (await rpcFromPage(page, d.network.aztecNode, "node_getNodeInfo")) as { l1ChainId?: unknown; rollupVersion?: unknown }
	if (Number(info.l1ChainId) !== d.network.l1ChainId || Number(info.rollupVersion) !== d.network.rollupVersion)
		throw new Error(
			`the node reports chain ${info.l1ChainId}, rollup ${info.rollupVersion}; the file pins ${d.network.l1ChainId}, ${d.network.rollupVersion}`,
		)
	console.log(`ok   node_getNodeInfo from the page: chain ${d.network.l1ChainId}, rollup version ${d.network.rollupVersion}`)
	const chain = await rpcFromPage(page, d.network.l1Rpc, "eth_chainId")
	if (chain !== SEPOLIA) throw new Error(`eth_chainId from the page is ${String(chain)}, not ${SEPOLIA}`)
	console.log(`ok   eth_chainId from the page: ${SEPOLIA}`)
}

async function assertReads(page: Page, d: ReturnType<typeof readTestnetDeployment>, offline: boolean): Promise<void> {
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

async function smoke(port: number, deployment: string, offline: boolean): Promise<void> {
	const d = readTestnetDeployment(deployment)
	const origin = `http://localhost:${port}`
	const browser = await chromium.launch({ headless: true })
	try {
		const context = await browser.newContext()
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
		await page.goto(`${origin}/`, { waitUntil: "load" })
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
	const claims = await Promise.all((offline ? ["smoke", "smoke-bot", "smoke-asp"] : ["smoke"]).map((s) => claimPort(s)))
	const [port, bot, asp] = claims.map((c) => c.port) as [number, number?, number?]
	const work = scratchDir("testnet-smoke")
	try {
		const deployment = bot && asp ? withUpstreams(resolve(values.target), work, bot, asp) : resolve(values.target)
		const circuits = offline ? join(work, "circuits") : process.env.PP_CIRCUITS_DIR
		if (offline) mkdirSync(circuits as string)
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
		try {
			await untilUp("serve --deployment", port, g)
			await smoke(port, deployment, offline)
		} finally {
			await g.stop()
		}
	} finally {
		await Promise.all(claims.map((c) => c.release()))
		rmSync(work, { recursive: true, force: true })
	}
	console.log(`test:testnet-smoke passed${offline ? " (no upstreams)" : ""}`)
}

await main()
