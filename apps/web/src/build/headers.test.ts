import { describe, expect, test } from "vitest"
import { contentSecurityPolicy, parseHeaderFile, securityHeaders } from "./headers"
import type { PublicTarget, StackTarget } from "./target"

const TARGET: PublicTarget = {
	nodeUrl: "http://127.0.0.1:8080",
	l1RpcUrl: "http://127.0.0.1:8545",
	l1ChainId: 31337,
	rollupVersion: 7,
	walletUrls: ["http://127.0.0.1:9001/?profile=plain", "http://127.0.0.1:9002/?profile=full"],
	dataMode: "fixtures",
	connector: "real",
	stack: null,
}

const A20 = `0x${"11".repeat(20)}`
const A32 = `0x${"22".repeat(32)}`
const STACK: PublicTarget = {
	...TARGET,
	rollupVersion: null,
	dataMode: "stack",
	stack: {
		manifest: {
			version: 1,
			chainId: 31337,
			l1Rpc: TARGET.l1RpcUrl,
			aztecNode: TARGET.nodeUrl,
			pool: {
				poolVault: A20,
				entrypoint: A20,
				aspRegistry: A20,
				keystore: A20,
				asset: A20,
				deployBlock: "1",
				aspApiUrl: "http://127.0.0.1:8600/api",
			},
			bridge: { factory: A20, portal: A20, hub: A32, token: A32, registry: A32, deployBlock: "2" },
		},
		botUrl: "http://127.0.0.1:8700/v1",
		sponsoredFpc: A32,
		demoSender: null,
	},
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
		// The artifact gateway is the page's own origin, so a stack target adds only bb.js's `data:` wasm,
		// the ASP API and the bot.
		expect(directives(contentSecurityPolicy(STACK))["connect-src"]).toEqual([
			"'self'",
			"data:",
			"http://127.0.0.1:8080",
			"http://127.0.0.1:8545",
			"http://127.0.0.1:8600",
			"http://127.0.0.1:8700",
		])
		expect(parseHeaderFile(JSON.stringify(securityHeaders(STACK)))).toEqual(securityHeaders(STACK))
	})

	test("a proxied stack target connects to its node and L1 RPC alone; its ASP and bot ride on 'self'", () => {
		const s = STACK.stack as StackTarget
		const proxied: PublicTarget = {
			...STACK,
			nodeUrl: "https://aztec-testnet.drpc.org",
			l1RpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
			walletUrls: [],
			stack: { ...s, manifest: { ...s.manifest, pool: { ...s.manifest.pool, aspApiUrl: "/asp" } }, botUrl: "/bot" },
		}
		expect(contentSecurityPolicy(proxied)).toBe(
			"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
				"font-src 'self'; connect-src 'self' data: https://aztec-testnet.drpc.org https://ethereum-sepolia-rpc.publicnode.com; " +
				"frame-src 'none'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		)
		expect(parseHeaderFile(JSON.stringify(securityHeaders(proxied)))).toEqual(securityHeaders(proxied))
	})

	test("a stack target differs from a fixture target in connect-src alone, and only there adds data:", () => {
		const fixture = directives(contentSecurityPolicy(TARGET))
		const stack = directives(contentSecurityPolicy(STACK))
		expect(Object.keys(stack)).toEqual(Object.keys(fixture))
		for (const name of Object.keys(fixture)) if (name !== "connect-src") expect(stack[name], name).toEqual(fixture[name])
		// img-src's `data:` is every build's; connect-src's is the stack's alone.
		const withData = (d: Record<string, string[]>) => Object.keys(d).filter((name) => d[name]?.includes("data:"))
		expect(withData(fixture)).toEqual(["img-src"])
		expect(withData(stack)).toEqual(["img-src", "connect-src"])
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

	test("read back only with every directive the build writes, each as the build writes it", () => {
		const headers = securityHeaders(TARGET)
		const csp = headers["Content-Security-Policy"]
		const without = (name: string) =>
			csp
				.split("; ")
				.filter((d) => !d.startsWith(`${name} `))
				.join("; ")
		const policies = [
			"default-src 'none';",
			without("frame-ancestors"),
			without("connect-src"),
			csp.replace("frame-src http://127.0.0.1:9001 http://127.0.0.1:9002", "frame-src https://*"),
			csp.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-eval'"),
			csp.replace("connect-src 'self' ", "connect-src 'self' blob: "),
			csp.replace("connect-src 'self' ", "connect-src 'self' data: data: "),
			csp.replace("connect-src 'self' http://127.0.0.1:8080 http://127.0.0.1:8545", "connect-src 'self' data:"),
			`${csp}; script-src *`,
		]
		for (const policy of policies)
			expect(() => parseHeaderFile(JSON.stringify({ ...headers, "Content-Security-Policy": policy })), policy).toThrow(
				/security-headers\.json/,
			)
	})
})
