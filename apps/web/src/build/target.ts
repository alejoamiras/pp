/**
 * The build's public target: the only chain coordinates the bundle may carry. The inputs also hold
 * keys (`handle.json` names the anvil and actor keys) or fields the page never needs (the bot's
 * accounts), so each allowed field is read and validated on its own and the target is assembled by
 * name; an unlisted field cannot reach `define`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getAddress, isAddress } from "viem"
import { z } from "zod"
// The config runs under Node, which cannot load `@pp/bridge-core`'s barrel (its imports carry no
// extensions); this module is self-contained and isomorphic.
import { parseStackManifest, requireBlocks } from "@pp/bridge-core/stack-manifest"
import { isLocalStack } from "../data/local-chain"

export type DataMode = "fixtures" | "stack"
export type ConnectorMode = "fixture" | "real"

/**
 * A stack manifest's pool and bridge, in the JSON shape `parseStackManifest` reads (bigints as
 * decimal strings). The adapters parse it again in the page, so a value that reaches the bundle
 * passes the same strict check twice.
 */
export interface StackManifestJson {
	readonly version: 1
	readonly chainId: number
	readonly l1Rpc: string
	readonly aztecNode: string
	readonly pool: {
		readonly poolVault: string
		readonly entrypoint: string
		readonly aspRegistry: string
		readonly keystore: string
		readonly asset: string
		readonly deployBlock: string
		readonly aspApiUrl: string
	}
	readonly bridge: {
		readonly factory: string
		readonly portal: string
		readonly hub: string
		readonly token: string
		readonly registry: string
		readonly deployBlock: string
	}
}

export interface StackTarget {
	readonly manifest: StackManifestJson
	/** The ASP bot's snapshot server. */
	readonly botUrl: string
	/** The canonical SponsoredFPC, derived at build time so its artifact never ships. */
	readonly sponsoredFpc: string
	/** The local demo's dev account, as an address only; `null` off chain 31337 or off a loopback L1 RPC. */
	readonly demoSender: string | null
}

export interface PublicTarget {
	readonly nodeUrl: string
	readonly l1RpcUrl: string
	readonly l1ChainId: number
	/** `null` on a stack target, whose manifest has none: the page takes the node's once its L1 chain id matches. */
	readonly rollupVersion: number | null
	/** Iframe wallets the connector probes, in order; empty outside a local build. */
	readonly walletUrls: readonly string[]
	readonly dataMode: DataMode
	readonly connector: ConnectorMode
	/** Present exactly when `dataMode` is `"stack"`. */
	readonly stack: StackTarget | null
}

export interface TargetEnv {
	PP_SANDBOX_ARTIFACTS?: string
	PP_STACK_MANIFEST?: string
	PP_WEB_WALLETS?: string
	PP_DATA?: string
}

/** A CSP host-source host with no wildcard: dot-separated letters, digits and hyphens. */
const SOURCE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/
const AZTEC_ADDRESS = /^0x[0-9a-f]{64}$/

/**
 * A URL a page may connect to: http(s) only; no userinfo, which is how a keyed endpoint leaks; and a
 * host its CSP source names exactly. URL parsing keeps `*` (and decodes `%2A` to it), which a source
 * reads as any host; an IPv6 literal is refused too, since a source cannot name one.
 */
function isPublicHttpUrl(raw: string): boolean {
	if (!URL.canParse(raw)) return false
	const url = new URL(raw)
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		url.username === "" &&
		url.password === "" &&
		SOURCE_HOST.test(url.hostname)
	)
}

/** `origin` is exactly the origin of a URL this target accepts, as the policy's source lists carry it. */
export const isPublicOrigin = (origin: string): boolean => isPublicHttpUrl(origin) && new URL(origin).origin === origin

const URL_RULE = "an http(s) URL without credentials whose host is a plain name or IPv4 address"

const publicUrl = z.string().refine(isPublicHttpUrl, `must be ${URL_RULE}`)

/** Unknown keys are dropped by the parse, and the target is still built by name from what is left. */
const handleFields = z.object({
	nodeUrl: publicUrl,
	anvilUrl: publicUrl,
	l1ChainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	rollupVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

function fail(source: string, problem: string): never {
	throw new Error(`build target: ${source} ${problem}`)
}

function readJson(file: string): unknown {
	let text: string
	try {
		text = readFileSync(file, "utf8")
	} catch {
		fail(file, "cannot be read")
	}
	try {
		return JSON.parse(text)
	} catch {
		fail(file, "is not JSON")
	}
}

function parseWalletUrls(raw: string | undefined): string[] {
	const urls = (raw ?? "")
		.split(",")
		.map((u) => u.trim())
		.filter((u) => u.length > 0)
	if (urls.length === 0) fail("PP_WEB_WALLETS", "lists no wallet URL")
	for (const url of urls) if (!isPublicHttpUrl(url)) fail("PP_WEB_WALLETS", `entry ${JSON.stringify(url)} is not ${URL_RULE}`)
	if (new Set(urls.map((u) => new URL(u).origin)).size !== urls.length) fail("PP_WEB_WALLETS", "repeats an origin")
	return urls
}

/** A stack manifest builds the stack data mode, a sandbox handle the fixture world; `PP_DATA`, when set, must agree. */
export function parseDataMode(env: Pick<TargetEnv, "PP_DATA" | "PP_STACK_MANIFEST">): DataMode {
	const implied: DataMode = env.PP_STACK_MANIFEST ? "stack" : "fixtures"
	const raw = env.PP_DATA
	if (raw === undefined || raw === "") return implied
	if (raw !== "fixtures" && raw !== "stack") fail("PP_DATA", `is ${JSON.stringify(raw)}; expected "fixtures" or "stack"`)
	if (raw !== implied) fail("PP_DATA", `is ${raw}, but PP_STACK_MANIFEST is ${env.PP_STACK_MANIFEST ? "set" : "unset"}`)
	return raw
}

/** Runs `f`, reporting what it throws as a problem with `source`. */
function attempt<T>(source: string, f: () => T): T {
	try {
		return f()
	} catch (err) {
		fail(source, err instanceof Error ? err.message : String(err))
	}
}

/** The demo sender rides only on the local stack; anywhere else it is dropped. */
function localDemoSender(m: { chainId: number; l1Rpc: string }, address: string | undefined): string | null {
	if (address === undefined || !isLocalStack(m)) return null
	if (!isAddress(address) || getAddress(address) !== address) fail("the demo sender", "is not a checksummed address")
	return address
}

/** The file `#demo-sender` names under `src/data/adapters/`: the real sender only for a target that carries one. */
export const demoSenderModule = (t: Pick<PublicTarget, "stack">): string => (t.stack?.demoSender ? "demo-sender.ts" : "demo-sender.stub.ts")

/** The manifest's public fields by name. */
function stackTarget(file: string, sponsoredFpc: string | undefined, demoSender: string | undefined): StackTarget {
	const json = readJson(file)
	const m = attempt(file, () => requireBlocks(parseStackManifest(json), ["bridge", "bot"]))
	for (const [field, url] of [
		["l1Rpc", m.l1Rpc],
		["aztecNode", m.aztecNode],
		["pool.aspApiUrl", m.pool.aspApiUrl],
		["bot.url", m.bot.url],
	] as const)
		if (!isPublicHttpUrl(url)) fail(file, `${field} is not ${URL_RULE}`)
	if (sponsoredFpc === undefined || !AZTEC_ADDRESS.test(sponsoredFpc)) fail("the SponsoredFPC address", "is missing or not 32-byte hex")
	const { pool: p, bridge: b } = m
	return {
		manifest: {
			version: 1,
			chainId: m.chainId,
			l1Rpc: m.l1Rpc,
			aztecNode: m.aztecNode,
			pool: {
				poolVault: p.poolVault,
				entrypoint: p.entrypoint,
				aspRegistry: p.aspRegistry,
				keystore: p.keystore,
				asset: p.asset,
				deployBlock: p.deployBlock.toString(),
				aspApiUrl: p.aspApiUrl,
			},
			bridge: {
				factory: b.factory,
				portal: b.portal,
				hub: b.hub,
				token: b.token,
				registry: b.registry,
				deployBlock: b.deployBlock.toString(),
			},
		},
		botUrl: m.bot.url,
		sponsoredFpc,
		demoSender: localDemoSender(m, demoSender),
	}
}

function handleTarget(file: string, local: boolean, env: TargetEnv): PublicTarget {
	const parsed = handleFields.safeParse(readJson(file))
	if (!parsed.success) fail(file, `is invalid: ${z.prettifyError(parsed.error)}`)
	const h = parsed.data
	return {
		nodeUrl: h.nodeUrl,
		l1RpcUrl: h.anvilUrl,
		l1ChainId: h.l1ChainId,
		rollupVersion: h.rollupVersion,
		walletUrls: local ? parseWalletUrls(env.PP_WEB_WALLETS) : [],
		dataMode: "fixtures",
		connector: local ? "real" : "fixture",
		stack: null,
	}
}

/**
 * The target for one build. `local` (`vite build --mode sandbox`, the kit's `build:local`) uses the
 * real connector and the wallet URLs in `PP_WEB_WALLETS`; it reads the stack manifest at
 * `PP_STACK_MANIFEST` (the stack adapters behind `#data`) or else the sandbox run's handle from
 * `PP_SANDBOX_ARTIFACTS` (the fixture world). Every other build reads `committedHandle` and uses the
 * fixture connector. `sponsoredFpc` is required for a stack target; `demoSender` is kept only on the local stack.
 *
 * @throws when an input is missing or a field fails validation, and when a stack build would use the
 *   fixture connector.
 */
export function resolveTarget(o: {
	local: boolean
	env: TargetEnv
	committedHandle: string
	sponsoredFpc?: string
	demoSender?: string
}): PublicTarget {
	const dataMode = parseDataMode(o.env)
	if (dataMode === "fixtures") {
		if (!o.local) return handleTarget(o.committedHandle, false, o.env)
		const dir = o.env.PP_SANDBOX_ARTIFACTS
		if (!dir) fail("PP_SANDBOX_ARTIFACTS", "is not set; a local build reads the sandbox run's handle.json from it")
		return handleTarget(join(dir, "handle.json"), true, o.env)
	}
	if (!o.local) fail("PP_DATA=stack", "needs the real connector: build with --mode sandbox")
	const stack = stackTarget(o.env.PP_STACK_MANIFEST as string, o.sponsoredFpc, o.demoSender)
	return {
		nodeUrl: stack.manifest.aztecNode,
		l1RpcUrl: stack.manifest.l1Rpc,
		l1ChainId: stack.manifest.chainId,
		rollupVersion: null,
		walletUrls: parseWalletUrls(o.env.PP_WEB_WALLETS),
		dataMode,
		connector: "real",
		stack,
	}
}
