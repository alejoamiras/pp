import { createPublicClient, custom, http, toHex } from "viem"
import { expect, it } from "vitest"
import { deriveKeys } from "../../src/keys.ts"
import { createArtifacts } from "../../src/runtime/artifacts.ts"
import { createSession } from "../../src/session.ts"
import type { PoolConfig } from "../../src/types.ts"
import { anvilAccount, derivationSignature } from "../support/users.ts"

const nowhere = "http://127.0.0.1:9"
const pool: PoolConfig = {
	chainId: 31337,
	l1Rpc: nowhere,
	poolVault: "0x0000000000000000000000000000000000000001",
	entrypoint: "0x0000000000000000000000000000000000000002",
	aspRegistry: "0x0000000000000000000000000000000000000003",
	keystore: "0x0000000000000000000000000000000000000004",
	asset: "0x0000000000000000000000000000000000000005",
	deployBlock: 0n,
	aspApiUrl: nowhere,
}

// Vitest reports a handle left open by the SDK's construction as a failure to exit.
it("builds a read-only session with no wallet and without touching the network", async () => {
	const owner = anvilAccount(13).address
	const sdk = await createSession({
		pool,
		owner,
		keys: deriveKeys(owner, await derivationSignature(13)),
		artifacts: createArtifacts({ kind: "gateway", urls: [nowhere] }),
		publicClient: createPublicClient({ transport: http(nowhere, { retryCount: 0 }) }),
	})
	expect(sdk.noteManager.getNotes()).toEqual([])
})

it("starts note discovery at the pool's deploy block, never at genesis", async () => {
	const owner = anvilAccount(13).address
	const deployBlock = 5_000_000n
	const reads: { address?: string; fromBlock?: string }[] = []
	// A chain whose history below the deploy block is pruned, as public Sepolia nodes serve it.
	const transport = custom({
		request: async ({ method, params }) => {
			if (method === "eth_chainId") return toHex(pool.chainId)
			if (method === "eth_blockNumber") return toHex(deployBlock + 100n)
			if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`)
			const [filter] = params as [{ address?: string; fromBlock?: string }]
			reads.push(filter)
			if (BigInt(filter.fromBlock ?? 0) < deployBlock) throw new Error("pruned history unavailable")
			return []
		},
	})
	const sdk = await createSession({
		pool: { ...pool, deployBlock },
		owner,
		keys: deriveKeys(owner, await derivationSignature(13)),
		artifacts: createArtifacts({ kind: "gateway", urls: [nowhere] }),
		publicClient: createPublicClient({ transport }),
	})
	await sdk.session.discoverNotes()
	const vault = reads.filter((r) => r.address?.toLowerCase() === pool.poolVault)
	expect(vault[0]?.fromBlock).toBe(toHex(deployBlock))
})
