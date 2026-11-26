/**
 * The response headers every served build carries, derived from its target alone. The build writes
 * them to `<outDir>/security-headers.json`; preview (and any later static server) serves that file's
 * set verbatim, so the policy is fixed at build time and never depends on the serving process's env.
 */
import { z } from "zod"
import type { PublicTarget } from "./target.ts"

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
	"Content-Security-Policy": z.string().startsWith("default-src 'none';"),
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
 * `'unsafe-inline'` styles: Radix's scroll lock injects a `<style>` element and the wallet SDK's panel
 * markup carries style attributes, and a static site cannot issue per-request nonces. No style value
 * comes from untrusted data. `'wasm-unsafe-eval'` compiles wasm only; JavaScript eval stays blocked.
 */
export function contentSecurityPolicy(t: PublicTarget): string {
	const frames = frameOrigins(t)
	return [
		"default-src 'none'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self'",
		`connect-src 'self' ${connectOrigins(t).join(" ")}`,
		`frame-src ${frames.length > 0 ? frames.join(" ") : "'none'"}`,
		"worker-src 'self' blob:",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ")
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
