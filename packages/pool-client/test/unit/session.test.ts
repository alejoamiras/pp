import { createPublicClient, custom, http, type PublicClient, toHex } from "viem"
import { expect, it } from "vitest"
import { deriveKeys } from "../../src/keys.ts"
import { createArtifacts } from "../../src/runtime/artifacts.ts"
import { NoteStatus } from "../../src/sdk.ts"
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

const deployBlock = 5_000_000n

/** A chain whose history below the deploy block is pruned, as public Sepolia nodes serve it. */
function prunedChain() {
	const reads: { address?: string; fromBlock?: string }[] = []
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
	return { reads, publicClient: createPublicClient({ transport }) }
}

async function sessionOn(publicClient: PublicClient) {
	const owner = anvilAccount(13).address
	const sdk = await createSession({
		pool: { ...pool, deployBlock },
		owner,
		keys: deriveKeys(owner, await derivationSignature(13)),
		artifacts: createArtifacts({ kind: "gateway", urls: [nowhere] }),
		publicClient,
	})
	return { owner, sdk }
}

it("starts note discovery at the pool's deploy block, never at genesis", async () => {
	const { reads, publicClient } = prunedChain()
	const { sdk } = await sessionOn(publicClient)
	await sdk.session.discoverNotes()
	const vault = reads.filter((r) => r.address?.toLowerCase() === pool.poolVault)
	expect(vault[0]?.fromBlock).toBe(toHex(deployBlock))
})

it("floors the SDK's rescan from block 0, taken when no ASP snapshot is served, at the deploy block", async () => {
	const { reads, publicClient } = prunedChain()
	const { owner, sdk } = await sessionOn(publicClient)
	const word = (n: bigint) => toHex(n, { size: 32 })
	sdk.noteManager.addNote({
		noteAddressHash: word(1n),
		commitment: word(2n),
		value: toHex(1n),
		tokenId: pool.asset,
		label: word(3n),
		status: NoteStatus.ACTIVE,
		ownerAddress: owner,
		noteSecret: word(4n),
		isOwned: true,
		createdAtBlock: toHex(deployBlock),
		spentAtBlock: null,
		txHash: word(5n),
	})
	// No ASP answers at `nowhere`, so the purge rescans the chain; the per-note check after it is not served.
	await sdk.session.purgePhantomNotes({ dryRun: true }).catch(() => undefined)
	expect(reads.length).toBeGreaterThan(0)
	expect(new Set(reads.map((r) => r.fromBlock))).toEqual(new Set([toHex(deployBlock)]))
})
