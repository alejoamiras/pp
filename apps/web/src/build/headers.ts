/**
 * The response headers every served build carries, derived from its target alone. The build writes
 * them to `<outDir>/security-headers.json`; preview (and any later static server) serves that file's
 * set verbatim, so the policy is fixed at build time and never depends on the serving process's env.
 */
import { z } from "zod"
import { isPublicOrigin, type PublicTarget } from "./target.ts"

export const HEADER_FILE = "security-headers.json"

/** Cross-origin isolation, which threaded wasm needs; the dev server sends only these. */
export const ISOLATION_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin",
} as const

const headerFile = z.strictObject({
	"Cross-Origin-Opener-Policy": z.literal(ISOLATION_HEADERS["Cross-Origin-Opener-Policy"]),
	"Cross-Origin-Embedder-Policy": z.literal(ISOLATION_HEADERS["Cross-Origin-Embedder-Policy"]),
	"Cross-Origin-Resource-Policy": z.literal(ISOLATION_HEADERS["Cross-Origin-Resource-Policy"]),
	"X-Content-Type-Options": z.literal("nosniff"),
	"Referrer-Policy": z.literal("no-referrer"),
	"Content-Security-Policy": z.string().refine((csp) => isBuiltPolicy(csp), "is not a policy this build writes"),
})

export type SecurityHeaders = z.infer<typeof headerFile>

const uniqueOrigins = (urls: readonly string[]): string[] => [...new Set(urls.map((u) => new URL(u).origin))]

/** Every origin the page fetches from: the node and the L1 RPC. Wallets are frames, not fetches. */
export function connectOrigins(t: PublicTarget): string[] {
	return uniqueOrigins([t.nodeUrl, t.l1RpcUrl])
}

export function frameOrigins(t: PublicTarget): string[] {
	return uniqueOrigins(t.walletUrls)
}

/**
 * The policy's directives in order; `connect` and `frame` stand for the target's origins. `'unsafe-inline'`
 * styles: Radix's scroll lock injects a `<style>` element and the wallet SDK's panel markup carries style
 * attributes, and a static site cannot issue per-request nonces. No style value comes from untrusted
 * data. `'wasm-unsafe-eval'` compiles wasm only; JavaScript eval stays blocked.
 */
const POLICY = [
	["default-src", "'none'"],
	["script-src", "'self' 'wasm-unsafe-eval'"],
	["style-src", "'self' 'unsafe-inline'"],
	["img-src", "'self' data:"],
	["font-src", "'self'"],
	["connect-src", "connect"],
	["frame-src", "frame"],
	["worker-src", "'self' blob:"],
	["frame-ancestors", "'none'"],
	["base-uri", "'none'"],
	["form-action", "'none'"],
] as const

export function contentSecurityPolicy(t: PublicTarget): string {
	const frames = frameOrigins(t)
	const lists = { connect: `'self' ${connectOrigins(t).join(" ")}`, frame: frames.length > 0 ? frames.join(" ") : "'none'" }
	return POLICY.map(([name, value]) => `${name} ${value === "connect" || value === "frame" ? lists[value] : value}`).join("; ")
}

/**
 * Whether `csp` is a policy `contentSecurityPolicy` writes for some target: every directive once and in
 * order, each fixed one verbatim, and the source lists made of exact origins a target accepts.
 */
export function isBuiltPolicy(csp: string): boolean {
	const parts = csp.split("; ")
	return (
		parts.length === POLICY.length &&
		POLICY.every(([name, value], i) => {
			const [head, ...sources] = (parts[i] as string).split(" ")
			if (head !== name) return false
			if (value === "connect") return sources[0] === "'self'" && sources.length > 1 && sources.slice(1).every(isPublicOrigin)
			if (value === "frame") return sources.join(" ") === "'none'" || (sources.length > 0 && sources.every(isPublicOrigin))
			return sources.join(" ") === value
		})
	)
}

export function securityHeaders(t: PublicTarget): SecurityHeaders {
	return {
		...ISOLATION_HEADERS,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Content-Security-Policy": contentSecurityPolicy(t),
	}
}

/** @throws when `text` is not exactly the header set `securityHeaders` writes. */
export function parseHeaderFile(text: string): SecurityHeaders {
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`${HEADER_FILE} is not JSON`)
	}
	const parsed = headerFile.safeParse(json)
	if (!parsed.success) throw new Error(`${HEADER_FILE} is not a valid header set: ${z.prettifyError(parsed.error)}`)
	return parsed.data
}
