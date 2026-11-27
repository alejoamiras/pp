import { EvmDeploymentSnapshotSource, startEvmMockAsp } from "#ppv2/mock-asp/evm"
import { claimPort, releasePorts, rowsOwnedBy } from "@pp/run-isolation/ports"
import { toHex } from "viem"
import type { ClientConfig, ClientDeployment } from "../client/types.ts"
import { stopAsp } from "./asp.ts"
import { assertForkNode } from "./harness/fork-node.ts"
import { RUN_ID } from "./run-id.ts"
import type { AttachForkOptions, ForkPoolEnv } from "./types.ts"

export type { AttachForkOptions, ForkPoolEnv } from "./types.ts"

type Asp = Awaited<ReturnType<typeof startEvmMockAsp>>

function handle(asp: Asp, aspRun: string, clientConfig: ClientConfig): ForkPoolEnv {
	let stopping = false
	let stopped: Promise<void> | undefined
	return {
		clientConfig,
		asp: {
			url: asp.url,
			approveLabel: async (label) => {
				if (stopping) throw new Error("the fork's mock ASP is stopped")
				return BigInt((await asp.approveLabel(toHex(label))).root)
			},
		},
		stop: () => {
			stopping = true
			// A failed stop can be retried: stopAsp accepts an ASP whose port already refuses.
			stopped ??= stopAsp(asp)
				.then(() => releasePorts(aspRun))
				.catch((err: unknown) => {
					stopped = undefined
					throw err
				})
			return stopped
		},
	}
}

/**
 * Attaches to the caller's fork and starts a mock ASP that impersonates `postman` there.
 * @throws Error when the node is not the caller's loopback anvil on `chainId`; nothing is left running
 */
export async function attachForkPoolEnv(o: AttachForkOptions): Promise<ForkPoolEnv> {
	const { rpcUrl, clientVersion, chainId, postman, circuitsDir, circuitBundle, runId } = o
	const { pool, entrypoint, keystore, aspRegistry, deployBlock } = o.deployment
	const deployment: ClientDeployment = { pool, entrypoint, keystore, aspRegistry, deployBlock }
	if (!RUN_ID.test(runId)) throw new Error(`runId ${JSON.stringify(runId)} must match ${RUN_ID}`)
	const aspRun = `${runId}-pool`
	if (rowsOwnedBy(aspRun) > 0) throw new Error(`run ${runId} already has a fork attach; stop it first`)
	await assertForkNode({ rpcUrl, clientVersion, chainId, runId })
	const port = await claimPort(aspRun, "pp-env-asp")
	try {
		const asp = await startEvmMockAsp({
			rpcUrl,
			chainId,
			aspRegistryAddress: aspRegistry,
			entrypointAddress: entrypoint,
			signer: { kind: "impersonate", address: postman },
			forkMode: true,
			// Nothing can predate the deployment, so discovery scans only from there; anvil serves that range from upstream.
			eventSource: new EvmDeploymentSnapshotSource({ chainId, deploymentBlock: deployBlock }),
			host: "127.0.0.1",
			port,
		})
		const clientConfig: ClientConfig = {
			rpcUrl,
			chainId,
			deployment,
			aspUrl: asp.url,
			circuitsDir,
			...(circuitBundle !== undefined && { circuitBundle }),
		}
		return handle(asp, aspRun, clientConfig)
	} catch (err) {
		await releasePorts(aspRun)
		throw err
	}
}
