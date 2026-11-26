import { describe, expect, test } from "vitest"
import { contentSecurityPolicy, parseHeaderFile, securityHeaders } from "./headers"
import type { PublicTarget } from "./target"

const TARGET: PublicTarget = {
	nodeUrl: "http://127.0.0.1:8080",
	l1RpcUrl: "http://127.0.0.1:8545",
	l1ChainId: 31337,
	rollupVersion: 7,
	walletUrls: ["http://127.0.0.1:9001/?profile=plain", "http://127.0.0.1:9002/?profile=full"],
	dataMode: "fixtures",
	connector: "real",
}

const directives = (csp: string): Record<string, string[]> =>
	Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]))

describe("security headers", () => {
	test("are exactly this set for a target", () => {
		expect(securityHeaders(TARGET)).toEqual({
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
				"font-src 'self'; connect-src 'self' http://127.0.0.1:8080 http://127.0.0.1:8545; " +
				"frame-src http://127.0.0.1:9001 http://127.0.0.1:9002; worker-src 'self' blob:; frame-ancestors 'none'; " +
				"base-uri 'none'; form-action 'none'",
		})
	})

	test("allow no script eval and no wildcard; connect-src and frame-src are exactly the target's origins", () => {
		const remote: PublicTarget = {
			...TARGET,
			nodeUrl: "https://node.example:8443/rpc?x=1",
			l1RpcUrl: "https://node.example:8443/l1",
			walletUrls: [],
		}
		for (const t of [TARGET, remote]) {
			const csp = contentSecurityPolicy(t)
			expect(csp).not.toContain("'unsafe-eval'")
			expect(csp).not.toContain("*")
		}
		expect(directives(contentSecurityPolicy(TARGET))["connect-src"]).toEqual([
			"'self'",
			"http://127.0.0.1:8080",
			"http://127.0.0.1:8545",
		])
		expect(directives(contentSecurityPolicy(remote))["connect-src"]).toEqual(["'self'", "https://node.example:8443"])
		expect(directives(contentSecurityPolicy(remote))["frame-src"]).toEqual(["'none'"])
	})

	test("read back from their file, and any other file is refused", () => {
		const headers = securityHeaders(TARGET)
		expect(parseHeaderFile(JSON.stringify(headers))).toEqual(headers)
		const { "Referrer-Policy": _dropped, ...missing } = headers
		for (const bad of [
			"{",
			JSON.stringify(missing),
			JSON.stringify({ ...headers, "Access-Control-Allow-Origin": "*" }),
			JSON.stringify({ ...headers, "Cross-Origin-Embedder-Policy": "unsafe-none" }),
			JSON.stringify({ ...headers, "Content-Security-Policy": "default-src *" }),
		]) {
			expect(() => parseHeaderFile(bad)).toThrow(/security-headers\.json/)
		}
	})
})
