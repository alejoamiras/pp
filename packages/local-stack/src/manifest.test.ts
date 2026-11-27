import { expect, test } from "vitest"
import { parseStackManifest, requireBlocks, serializeStackManifest } from "@pp/bridge-core"
import { buildManifest } from "./manifest.ts"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const

test("a manifest built from a booted stack's facts parses back unchanged", () => {
	const m = buildManifest({
		chainId: 31337,
		l1Rpc: "http://127.0.0.1:10285",
		aztecNode: "http://127.0.0.1:12024",
		pool: { poolVault: addr(1), entrypoint: addr(2), aspRegistry: addr(3), keystore: addr(4), deployBlock: 21n },
		asset: addr(5),
		aspUrl: "http://127.0.0.1:19001",
	})
	expect(parseStackManifest(JSON.parse(serializeStackManifest(m)))).toEqual(m)
	expect(m.pool).toMatchObject({ asset: addr(5), aspApiUrl: "http://127.0.0.1:19001", deployBlock: 21n })
})

test("the bridge block survives the round trip and satisfies requireBlocks", () => {
	const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const
	const bridge = { factory: addr(6), portal: addr(7), hub: word(8), token: word(9), registry: word(0), deployBlock: 30n }
	const m = buildManifest({
		chainId: 31337,
		l1Rpc: "http://127.0.0.1:10285",
		aztecNode: "http://127.0.0.1:12024",
		pool: { poolVault: addr(1), entrypoint: addr(2), aspRegistry: addr(3), keystore: addr(4), deployBlock: 21n },
		asset: addr(5),
		aspUrl: "http://127.0.0.1:19001",
		bridge,
	})
	expect(requireBlocks(parseStackManifest(JSON.parse(serializeStackManifest(m))), ["bridge"]).bridge).toEqual(bridge)
})
