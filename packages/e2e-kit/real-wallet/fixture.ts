/**
 * The real-wallet suite's `test`: one worker owns the pinned wallet in a persistent Chromium context
 * behind the browser-level fence, its proving points seeded in a launch of their own, a recording
 * proxy in front of the stack's node, the kit's injected Ethereum wallet as the stack's seeded user
 * and the one app page the spec drives. Stack mode only. Everything the worker creates lives under
 * `<state>/real-wallet/` and is deleted by it; nothing else is.
 */
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { test as base, type BrowserContext, expect, type Page, type TestInfo } from "@playwright/test"
import { walletChainIdOf } from "@pp/bridge-core"
import { type RunEnv, runEnv, stackRun } from "../env"
import { installL1Wallet, type L1WalletControl } from "../fixtures/l1-wallet"
import { openNetwork } from "../fixtures/network"
import { type Chain, chainAt } from "./chain"
import { prepareCrs, readCrsPin, type SeedArrays } from "./crs"
import { type WalletDriver, walletDriver } from "./driver"
import { type EgressRecorder, type Listener, startEgressRecorder, startOwnedProbe, startTripwire } from "./egress-recorder"
import { fetchWallet, readWalletPin } from "./fetch-wallet"
import { snapshotOwned } from "./inventory"
import { launchWallet, type WalletLaunch } from "./launch"
import { type NodeRecorder, startNodeRecorder } from "./node-recorder"
import { cacheHashes, pinnedCache, seedCache, startSeedServer } from "./seed"

export const CANARY_HOST = "egress-canary.invalid:80"

export interface Attributed {
	/** `host:port` */
	target: string
	from: string
}

export interface RealWallet extends WalletLaunch {
	appPage: Page
	appOrigin: string
	driver: WalletDriver
	node: NodeRecorder
	/** The stack's own node, read around the recorder so the reads stay out of the wallet's record. */
	chain: Chain
	/** The app page's injected Ethereum wallet, signing as the stack's seeded pool user. */
	l1: L1WalletControl
	egress: EgressRecorder
	/** The id the wallet must give the stack's network: `l1ChainId XOR rollupVersion`. */
	expectedChainId: number
	sandboxed: boolean
	/** The test launch's owned loopback ports, the only ones that bypass the recorder. */
	owned: number[]
	/** Page and service-worker requests off the owned ports, with the context that made them. */
	requests: Attributed[]
	/** Recorder targets the canaries produced, kept apart from the wallet's own refusals. */
	canaryTargets: Set<string>
	checkCache(): Promise<void>
	log(line: string): void
	lines: string[]
}

interface Stack {
	nodeUrl: string
	expectedChainId: number
	ports: number[]
}

const loopbackPorts = (v: unknown, out: Set<number> = new Set()): Set<number> => {
	if (typeof v === "string") {
		const m = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(v)
		if (m) out.add(Number(m[1]))
	} else if (v && typeof v === "object") for (const x of Object.values(v)) loopbackPorts(x, out)
	return out
}

/** The stack's coordinates from its handle, and every loopback port its handle and manifest name. */
function stackOf(run: RunEnv): Stack {
	if (run.mode !== "stack") throw new Error("real wallet: runs on the local stack only (PP_E2E_MODE=stack, which run.ts sets)")
	const read = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {})
	const handle = read(join(run.artifactsDir, "handle.json")) as { nodeUrl?: string; l1ChainId?: number; rollupVersion?: number }
	if (!handle.nodeUrl || handle.l1ChainId === undefined || handle.rollupVersion === undefined)
		throw new Error(`real wallet: ${run.artifactsDir}/handle.json names no node, L1 chain or rollup version`)
	const ports = loopbackPorts([handle, read(stackRun(run).manifestPath)])
	return { nodeUrl: handle.nodeUrl, expectedChainId: walletChainIdOf(handle.l1ChainId, handle.rollupVersion), ports: [...ports] }
}

const normalTarget = (u: URL) => `${u.hostname}:${u.port || (u.protocol === "https:" || u.protocol === "wss:" ? "443" : "80")}`

/** Recorder hits for both canaries and a direct hit on the owned probe, or a named failure. */
async function runCanaries(
	context: BrowserContext,
	egress: EgressRecorder,
	tripwire: Listener & { connections(): number },
	probe: Listener & { connections(): number },
) {
	const before = probe.connections()
	const wire = `127.0.0.1:${tripwire.port}`
	const page = await context.newPage()
	await page.evaluate(
		async (urls) => {
			await Promise.allSettled(urls.map((u) => fetch(u, { mode: "no-cors", cache: "no-store" })))
		},
		[`http://${CANARY_HOST.replace(":80", "")}/`, `http://${wire}/`, `http://127.0.0.1:${probe.port}/`],
	)
	await page.close()
	const seen = new Set(egress.hits().map((h) => h.target))
	const broken = [
		!seen.has(CANARY_HOST) && "the remote canary never reached the recorder",
		!seen.has(wire) && "the unowned loopback canary never reached the recorder",
		tripwire.connections() !== 0 && `the unowned loopback listener was reached directly (${tripwire.connections()} connections)`,
		probe.connections() <= before && "the owned probe was not reached directly",
	].filter(Boolean)
	if (broken.length > 0) throw new Error(`fence: ${broken.join("; ")}`)
	return [CANARY_HOST, wire]
}

/** Chromium's sandbox when it starts unmodified, else none; which one ran is part of the record. */
async function launchFenced(
	plan: Omit<Parameters<typeof launchWallet>[0], "sandbox">,
	sandbox: boolean,
): Promise<WalletLaunch & { sandboxed: boolean }> {
	if (sandbox) {
		try {
			return { ...(await launchWallet({ ...plan, sandbox: true })), sandboxed: true }
		} catch (err) {
			if (!/No usable sandbox/.test(String(err))) throw err
		}
	}
	return { ...(await launchWallet({ ...plan, sandbox: false })), sandboxed: false }
}

function attribute(context: BrowserContext, owned: Set<number>, origin: string, appOrigin: string, out: Attributed[]): void {
	const labelOf = (url: string) =>
		url.startsWith(`${origin}/src/onboarding/`)
			? "onboarding tab"
			: url.startsWith(`${origin}/src/popup/`)
				? "popup"
				: url.startsWith(origin)
					? "wallet page"
					: url.startsWith(appOrigin)
						? "app"
						: `page ${url.slice(0, 80)}`
	context.on("request", (req) => {
		const u = new URL(req.url())
		if (!/^(https?|wss?):$/.test(u.protocol)) return
		if (u.hostname === "127.0.0.1" && owned.has(Number(u.port))) return
		const sw = req.serviceWorker()
		out.push({ target: normalTarget(u), from: sw ? "service worker" : labelOf(req.frame().page().url()) })
	})
}

interface Prepared {
	dir: string
	extensionDir: string
	profileDir: string
	seed: SeedArrays
	stack: Stack
	knownPorts: number[]
}

async function prepare(run: RunEnv, dir: string, log: (s: string) => void): Promise<Prepared> {
	const stack = stackOf(run)
	const knownPorts = [
		...new Set([run.appPort, ...Object.values(run.testWalletOrigins).map((o) => Number(new URL(o).port)), ...stack.ports]),
	]
	const profileDir = join(dir, "profile")
	snapshotOwned(run.stateDir, knownPorts, profileDir)
	const extensionDir = join(dir, "extension")
	await fetchWallet(readWalletPin(), { cacheDir: join(homedir(), ".cache/pp/wallets"), extensionDir })
	log(`wallet ${readWalletPin().version} unpacked`)
	const seed = await prepareCrs(readCrsPin(), join(dir, "crs"))
	log("proving points prepared and checked")
	return { dir, extensionDir, profileDir, seed, stack, knownPorts }
}

export const test = base.extend<{ fences: undefined; digested: undefined }, { run: RunEnv; realWallet: RealWallet }>({
	run: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructuring form even with no dependencies.
		async ({}, use) => {
			await use(runEnv())
		},
		{ scope: "worker" },
	],

	realWallet: [
		async ({ run }, use) => {
			const lines: string[] = []
			const log = (s: string) => {
				lines.push(`${new Date().toISOString()} ${s}`)
				console.log(`[real-wallet] ${s}`)
			}
			const closers: (() => Promise<unknown>)[] = []
			let created: string | undefined
			try {
				const dir = join(run.stateDir, "real-wallet")
				// Throws if it exists: whatever is there is not this worker's to delete.
				mkdirSync(dir)
				created = dir
				const p = await prepare(run, dir, log)
				const egress = await startEgressRecorder()
				const tripwire = await startTripwire()
				const probe = await startOwnedProbe()
				const node = await startNodeRecorder(p.stack.nodeUrl)
				const seedServer = await startSeedServer(p.seed)
				closers.push(egress.close, tripwire.close, probe.close, node.close, seedServer.close)
				const plan = { profileDir: p.profileDir, extensionDir: p.extensionDir, recorderPort: egress.port }

				const seeding = await launchFenced({ ...plan, ownedPorts: [seedServer.port, probe.port] }, true)
				closers.unshift(() => seeding.context.close())
				const canaryTargets = new Set(await runCanaries(seeding.context, egress, tripwire, probe))
				log(`seed launch: canaries passed, sandbox ${seeding.sandboxed ? "on" : "unavailable"}`)
				log(`seeded ${JSON.stringify(await seedCache(seeding.worker, seedServer.url))}`)
				await seeding.context.close()

				const owned = [...p.knownPorts, node.port, probe.port]
				const l = await launchFenced({ ...plan, ownedPorts: owned }, seeding.sandboxed)
				closers.unshift(() => l.context.close())
				for (const t of await runCanaries(l.context, egress, tripwire, probe)) canaryTargets.add(t)
				log("test launch: canaries passed")
				const want = pinnedCache(readCrsPin())
				const checkCache = async () =>
					expect(await cacheHashes(l.worker), "the seeded proving points, as the wallet reads them").toEqual(want)
				await checkCache()
				log("seeded proving points read back at their pinned hashes")

				const requests: Attributed[] = []
				attribute(l.context, new Set(owned), `chrome-extension://${l.extensionId}`, run.appOrigin, requests)
				// Before the app page exists: the shim is a context init script and binding.
				const user = (await openNetwork(run)).l1(0)
				const l1 = await installL1Wallet(l.context, { ...user, appOrigin: run.appOrigin })
				const appPage = await l.context.newPage()
				const driver = walletDriver(l.context, l.extensionId, randomBytes(18).toString("base64url"))
				await use({
					...l,
					appPage,
					appOrigin: run.appOrigin,
					driver,
					node,
					chain: chainAt(p.stack.nodeUrl),
					l1,
					egress,
					expectedChainId: p.stack.expectedChainId,
					requests,
					canaryTargets,
					owned,
					checkCache,
					log,
					lines,
				})
			} finally {
				for (const close of closers) await close().catch(() => {})
				if (created) rmSync(created, { recursive: true, force: true })
			}
		},
		{ scope: "worker", timeout: 10 * 60_000 },
	],

	// The config's `trace: "retain-on-failure"` already records this context per test.
	digested: [
		async ({ realWallet }, use, testInfo) => {
			await use(undefined)
			if (testInfo.status !== testInfo.expectedStatus) digest(realWallet, testInfo)
		},
		{ auto: true },
	],

	fences: [
		async ({ realWallet }, use) => {
			await use(undefined)
			const declared = new Set((readDeclared().hosts ?? []).map((h) => h.host))
			const refused = refusals(realWallet).filter((r) => !declared.has(r.target))
			expect(refused, "every refused host is one the director approved").toEqual([])
			expect(
				realWallet.requests.filter((r) => r.from === "app"),
				"no app-page request left the owned loopback ports",
			).toEqual([])
		},
		{ auto: true },
	],
})

function readDeclared(): { hosts?: { host: string }[] } {
	return JSON.parse(readFileSync(new URL("./declared-refusals.json", import.meta.url), "utf8"))
}

/** Each refused target once, with every context that tried it; recorder-only targets came from no page or worker. */
export function refusals(rw: Pick<RealWallet, "egress" | "requests" | "canaryTargets">): { target: string; from: string[] }[] {
	const by = new Map<string, Set<string>>()
	for (const r of rw.requests) if (!rw.canaryTargets.has(r.target)) by.set(r.target, (by.get(r.target) ?? new Set()).add(r.from))
	for (const h of rw.egress.hits())
		if (!rw.canaryTargets.has(h.target) && !by.has(h.target)) by.set(h.target, new Set(["offscreen document or the browser itself"]))
	return [...by].map(([target, from]) => ({ target, from: [...from].sort() })).sort((a, b) => a.target.localeCompare(b.target))
}

function digest(rw: RealWallet, testInfo: TestInfo): void {
	const d = {
		step: testInfo.title,
		windows: rw.context.pages().map((p) => p.url()),
		nodeCalls: rw.node
			.calls()
			.slice(-40)
			.map((c) => `${c.seq} ${c.method}${c.error ? ` ERROR ${c.error}` : ""}`),
		refused: refusals(rw),
		log: rw.lines.slice(-30),
	}
	console.log(`[real-wallet] failure digest\n${JSON.stringify(d, null, 2)}`)
	const path = testInfo.outputPath("failure-digest.json")
	writeFileSync(path, JSON.stringify(d, null, 2))
	void testInfo.attach("failure-digest.json", { path, contentType: "application/json" })
}

export { expect }
