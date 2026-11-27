import { describe, expect, it } from "vitest"
import { KEYSTORE_ROOT_MARGIN_SECONDS, type RootReader, readRoots, staleRoot } from "../../src/fresh.ts"
import type { PoolConfig } from "../../src/types.ts"

const roots = { state: 1n, keystore: 2n, asp: 3n }
const now = 1_000_000n
const fresh = { stateKnown: true, keystoreCurrent: 2n, keystoreValidUntil: 0n, aspLatest: 3n, timestamp: now }

describe("staleRoot", () => {
	it("passes current roots", () => expect(staleRoot(roots, fresh)).toBeNull())

	it("gives a superseded keystore root a margin of chain time before its expiry", () => {
		const superseded = (left: bigint) => ({ ...fresh, keystoreCurrent: 9n, keystoreValidUntil: now + left })
		expect(KEYSTORE_ROOT_MARGIN_SECONDS).toBe(120n)
		expect(staleRoot(roots, superseded(121n))).toBeNull()
		expect(staleRoot(roots, superseded(120n))).toBe("KEYSTORE_ROOT_STALE")
		expect(staleRoot(roots, { ...fresh, keystoreCurrent: 9n, keystoreValidUntil: 0n })).toBe("KEYSTORE_ROOT_STALE")
	})

	it("names the state root, then the keystore root, then the ASP root", () => {
		expect(staleRoot(roots, { ...fresh, stateKnown: false, aspLatest: 4n })).toBe("STATE_ROOT_STALE")
		expect(staleRoot(roots, { ...fresh, aspLatest: 4n })).toBe("ASP_ROOT_STALE")
	})
})

it("reads all four views at the one block it fetched", async () => {
	const blocks: bigint[] = []
	const values: Record<string, unknown> = { isKnownRoot: true, currentRoot: 2n, previousRoots: 0n, latestASPRoot: 3n }
	const reader: RootReader = {
		getBlock: async () => ({ number: 77n, timestamp: now }),
		readContract: async (call) => {
			blocks.push(call.blockNumber)
			return values[call.functionName]
		},
	}
	const reads = await readRoots(reader, {} as PoolConfig, roots)
	expect(blocks).toEqual([77n, 77n, 77n, 77n])
	expect(staleRoot(roots, reads)).toBeNull()
})
