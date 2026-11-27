/**
 * The build's public target: the only chain coordinates the bundle may carry. The inputs also hold
 * keys (`handle.json` names the anvil and actor keys), so each allowed field is read and validated on
 * its own and the target is assembled by name; an unlisted field cannot reach `define`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

export type DataMode = "fixtures" | "stack"
export type ConnectorMode = "fixture" | "real"

export interface PublicTarget {
	readonly nodeUrl: string
	readonly l1RpcUrl: string
	readonly l1ChainId: number
	readonly rollupVersion: number
	/** Iframe wallets the connector probes, in order; empty outside a local build. */
	readonly walletUrls: readonly string[]
	readonly dataMode: DataMode
	readonly connector: ConnectorMode
}

export interface TargetEnv {
	PP_SANDBOX_ARTIFACTS?: string
	PP_WEB_WALLETS?: string
	PP_DATA?: string
}

/** A CSP host-source host with no wildcard: dot-separated letters, digits and hyphens. */
const SOURCE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/

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

function readHandle(file: string): unknown {
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

export function parseDataMode(raw: string | undefined): DataMode {
	if (raw === undefined || raw === "" || raw === "fixtures") return "fixtures"
	if (raw === "stack") return "stack"
	fail("PP_DATA", `is ${JSON.stringify(raw)}; expected "fixtures" or "stack"`)
}

/**
 * The target for one build. `local` (`vite build --mode sandbox`, the kit's `build:local`) reads the
 * sandbox run's handle from `PP_SANDBOX_ARTIFACTS` and the wallet URLs from `PP_WEB_WALLETS`, and uses
 * the real connector; every other build reads `committedHandle` and uses the fixture connector.
 *
 * @throws when an input is missing or a field fails validation, and when a stack build would use the
 *   fixture connector.
 */
export function resolveTarget(o: { local: boolean; env: TargetEnv; committedHandle: string }): PublicTarget {
	const dataMode = parseDataMode(o.env.PP_DATA)
	if (dataMode === "stack" && !o.local) fail("PP_DATA=stack", "needs the real connector: build with --mode sandbox")
	let handleFile = o.committedHandle
	if (o.local) {
		const dir = o.env.PP_SANDBOX_ARTIFACTS
		if (!dir) fail("PP_SANDBOX_ARTIFACTS", "is not set; a local build reads the sandbox run's handle.json from it")
		handleFile = join(dir, "handle.json")
	}
	const parsed = handleFields.safeParse(readHandle(handleFile))
	if (!parsed.success) fail(handleFile, `is invalid: ${z.prettifyError(parsed.error)}`)
	const h = parsed.data
	return {
		nodeUrl: h.nodeUrl,
		l1RpcUrl: h.anvilUrl,
		l1ChainId: h.l1ChainId,
		rollupVersion: h.rollupVersion,
		walletUrls: o.local ? parseWalletUrls(o.env.PP_WEB_WALLETS) : [],
		dataMode,
		connector: o.local ? "real" : "fixture",
	}
}
