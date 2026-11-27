import { describe, expect, test } from "vitest"
import { resolveSameOrigin, SAME_ORIGIN } from "./same-origin"
import type { PublicTarget, StackTarget } from "./target"

const A20 = `0x${"11".repeat(20)}`
const A32 = `0x${"22".repeat(32)}`
const stack = (aspApiUrl: string, botUrl: string): StackTarget => ({
	manifest: {
		version: 1,
		chainId: 11155111,
		l1Rpc: "https://ethereum-sepolia-rpc.publicnode.com",
		aztecNode: "https://aztec-testnet.drpc.org",
		pool: { poolVault: A20, entrypoint: A20, aspRegistry: A20, keystore: A20, asset: A20, deployBlock: "1", aspApiUrl },
		bridge: { factory: A20, portal: A20, hub: A32, token: A32, registry: A32, deployBlock: "2" },
	},
	botUrl,
	sponsoredFpc: A32,
	demoSender: null,
})
const target = (s: StackTarget | null): PublicTarget => ({
	nodeUrl: "https://aztec-testnet.drpc.org",
	l1RpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
	l1ChainId: 11155111,
	rollupVersion: 3,
	walletUrls: [],
	dataMode: s ? "stack" : "fixtures",
	connector: "real",
	stack: s,
})
const ORIGIN = "http://localhost:28600"

describe("resolveSameOrigin", () => {
	test("makes both proxied paths absolute against the page's origin and changes nothing else", () => {
		const t = target(stack(SAME_ORIGIN.asp, SAME_ORIGIN.bot))
		expect(resolveSameOrigin(t, ORIGIN)).toEqual(target(stack(`${ORIGIN}/asp`, `${ORIGIN}/bot`)))
	})

	test("returns any other target as it is, origin or not", () => {
		for (const t of [target(null), target(stack("http://127.0.0.1:8600", "http://127.0.0.1:8700"))]) {
			expect(resolveSameOrigin(t, ORIGIN)).toBe(t)
			expect(resolveSameOrigin(t, undefined)).toBe(t)
		}
		// Only the exact paths count: a look-alike stays as built, and the manifest parser refuses it later.
		const lookAlike = target(stack("/asp/", "/bot/"))
		expect(resolveSameOrigin(lookAlike, ORIGIN)).toBe(lookAlike)
	})

	test("refuses half a proxied target, and a proxied target with no origin", () => {
		expect(() => resolveSameOrigin(target(stack(SAME_ORIGIN.asp, "http://127.0.0.1:8700")), ORIGIN)).toThrow(/both/)
		expect(() => resolveSameOrigin(target(stack("http://127.0.0.1:8600", SAME_ORIGIN.bot)), ORIGIN)).toThrow(/both/)
		expect(() => resolveSameOrigin(target(stack(SAME_ORIGIN.asp, SAME_ORIGIN.bot)), undefined)).toThrow(/origin/)
	})
})
