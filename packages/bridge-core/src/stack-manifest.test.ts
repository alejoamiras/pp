import { describe, expect, it } from "vitest"
import { parseStackManifest, requireBlocks, type StackManifest, serializeStackManifest } from "./stack-manifest"

const evm = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const
const aztec = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const

const POOL_ONLY: StackManifest = {
	version: 1,
	chainId: 31337,
	l1Rpc: "http://127.0.0.1:10285",
	aztecNode: "http://127.0.0.1:12024",
	pool: {
		poolVault: evm(1),
		entrypoint: evm(2),
		aspRegistry: evm(3),
		keystore: evm(4),
		asset: evm(5),
		deployBlock: 18n,
		aspApiUrl: "http://127.0.0.1:19001",
	},
}

const FULL: StackManifest = {
	...POOL_ONLY,
	bridge: { factory: evm(6), portal: evm(7), hub: aztec(8), token: aztec(9), registry: aztec(10), deployBlock: 2n ** 64n + 1n },
	bot: { url: "http://localhost:19002", poster: aztec(11), birthIntake: aztec(12) },
	artifacts: { baseUrl: "http://[::1]:19003/artifacts" },
}

/** What a reader gets: the serialized text, decoded. */
const decoded = (m: StackManifest) => JSON.parse(serializeStackManifest(m)) as Record<string, unknown>

describe("stack manifest", () => {
	it.each([
		["full", FULL],
		["pool-only", POOL_ONLY],
	])("a %s manifest survives a round trip unchanged", (_name, m) => {
		const text = serializeStackManifest(m)
		expect(text.endsWith("}\n")).toBe(true)
		expect(text).toContain('\n\t"version": 1')
		expect(parseStackManifest(JSON.parse(text))).toEqual(m)
	})

	it("writes bigints as decimal strings", () => {
		expect(decoded(FULL).bridge).toMatchObject({ deployBlock: "18446744073709551617" })
	})

	it.each([
		["an unknown key", { ...decoded(POOL_ONLY), extra: 1 }, '(root): Unrecognized key: "extra"'],
		[
			"an unknown nested key",
			{ ...decoded(POOL_ONLY), pool: { ...POOL_ONLY.pool, deployBlock: "18", relay: evm(9) } },
			'pool: Unrecognized key: "relay"',
		],
		["version 2", { ...decoded(POOL_ONLY), version: 2 }, "version:"],
		[
			"a bigint as a JSON number",
			{ ...decoded(POOL_ONLY), pool: { ...(decoded(POOL_ONLY).pool as object), deployBlock: 18 } },
			"pool.deployBlock:",
		],
		[
			"a non-loopback L1 URL on chain 31337",
			{ ...decoded(POOL_ONLY), l1Rpc: "http://10.0.0.5:8545" },
			"l1Rpc: chain 31337 needs a loopback",
		],
		["https on chain 31337", { ...decoded(FULL), artifacts: { baseUrl: "https://127.0.0.1/a" } }, "artifacts.baseUrl: chain 31337"],
		[
			"a malformed nested URL",
			{ ...decoded(POOL_ONLY), pool: { ...(decoded(POOL_ONLY).pool as object), aspApiUrl: "garbage" } },
			"stack manifest failed strict validation — pool.aspApiUrl:",
		],
		[
			"a 19-byte address",
			{ ...decoded(POOL_ONLY), pool: { ...(decoded(POOL_ONLY).pool as object), poolVault: `0x${"ab".repeat(19)}` } },
			"pool.poolVault:",
		],
		[
			"a 31-byte Aztec address",
			{ ...decoded(FULL), bridge: { ...(decoded(FULL).bridge as object), hub: `0x${"cd".repeat(31)}` } },
			"bridge.hub:",
		],
	])("refuses %s, naming the field", (_name, json, field) => {
		expect(() => parseStackManifest(json)).toThrow(field)
	})

	it("accepts a remote URL off chain 31337", () => {
		const sepolia = { ...decoded(POOL_ONLY), chainId: 11155111, l1Rpc: "https://rpc.example.org" }
		expect(parseStackManifest(sepolia).l1Rpc).toBe("https://rpc.example.org")
	})

	it("requireBlocks names the blocks a manifest lacks", () => {
		expect(() => requireBlocks(POOL_ONLY, ["bridge"])).toThrow("stack manifest has no bridge block")
		expect(() => requireBlocks(POOL_ONLY, ["bridge", "bot"])).toThrow("no bridge, bot blocks")
		expect(requireBlocks(FULL, ["bridge", "bot", "artifacts"]).bridge.hub).toBe(aztec(8))
	})
})
