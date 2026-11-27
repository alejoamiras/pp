/**
 * What the stack specs read in Node, from the run's manifest: the seeded user's pool client, under the
 * same keys the page derives at sign-in, and the asset as the factory registered it.
 */
import { readFileSync } from "node:fs"
import { fromWord, parseStackManifest, readRegistration, requireBlocks } from "@pp/bridge-core"
import { type RunEnv, stackRun } from "@pp/e2e-kit/env.ts"
import { openPoolClient, type PoolNoteView } from "@pp/pool-client"
import { anvilAccount, circuitsDir, derivationSignature } from "@pp/pool-client/testing"
import { createPublicClient, http } from "viem"

export async function seededStack(run: RunEnv) {
	const stack = stackRun(run)
	const manifest = requireBlocks(parseStackManifest(JSON.parse(readFileSync(stack.manifestPath, "utf8"))), ["bridge", "bot"])
	const { index } = stack.accounts.user
	const owner = anvilAccount(index).address
	const signature = await derivationSignature(index)
	const pool = await openPoolClient({
		pool: { chainId: manifest.chainId, l1Rpc: manifest.l1Rpc, ...manifest.pool },
		l1Address: owner,
		signature,
		artifacts: { kind: "dir", path: circuitsDir() },
	})
	const reads = createPublicClient({ transport: http(manifest.l1Rpc) })
	const registration = await readRegistration(reads, manifest.bridge.factory, manifest.pool.asset)
	if (!registration) throw new Error("the stack's factory registers no portal for the pool's asset")
	return { stack, manifest, pool, owner, signature, decimals: registration.decimals, symbol: fromWord(registration.symbolWord) }
}

/** The seeded user's first approved note with value left; a bridged note's change counts. */
export async function approvedNote(pool: { notes(): Promise<PoolNoteView[]> }): Promise<PoolNoteView> {
	const note = (await pool.notes()).find((n) => n.value > 0n && n.status === "approved")
	if (!note) throw new Error("the stack holds no approved note with value left")
	return note
}
