import { randomBytes } from "node:crypto"
import { EvmDeploymentSnapshotSource } from "#ppv2/mock-asp/evm"
import { toHex } from "viem"
import { SEPOLIA } from "./chain.ts"
import { startFront } from "./front.ts"
import { createLabels } from "./labels.ts"
import type { StandInAsp, StartStandInAspOptions } from "./types.ts"

/**
 * Serves an operator pool's ASP read routes with nothing behind them: the root given, no leaves, and an
 * X25519 key drawn here and never kept, so no one can read a label encrypted to it. It reads no chain,
 * approves nothing and signs nothing.
 */
export async function startStandInAsp(o: StartStandInAspOptions): Promise<StandInAsp> {
	// The seed is any 32 bytes: the derivation hashes it, and the pair dies with the process.
	const labels = await createLabels(toHex(randomBytes(32)))
	const snapshots = new EvmDeploymentSnapshotSource({ chainId: SEPOLIA, deploymentBlock: o.deployBlock })
	const front = startFront({
		port: o.port,
		chainId: SEPOLIA,
		entrypoint: o.entrypoint,
		state: { root: () => o.root, leaves: () => [], publicKey: labels.publicKey, snapshot: () => snapshots.getEventSnapshot() },
	})
	return { url: front.url, publicKey: labels.publicKey, stop: front.stop }
}
