// The pool side of a fork of a live chain: a mock ASP that publishes as the real postman on the
// caller's own anvil. Users come from `createPoolUser`; nothing here holds or derives a key.
import { EvmDeploymentSnapshotSource, startEvmMockAsp } from "#ppv2/mock-asp/evm"
import { claimPort, releasePorts } from "@pp/run-isolation/ports"
import { toHex } from "viem"
import type { ClientConfig } from "../client/types.ts"
import { stopAsp } from "./asp.ts"
import { assertForkNode } from "./harness/fork-node.ts"
import type { AttachForkOptions, ForkPoolEnv } from "./types.ts"

export type { AttachForkOptions, ForkPoolEnv } from "./types.ts"

/**
 * Attaches to the caller's fork and starts a mock ASP that impersonates `postman` there.
 * @throws Error when the node is not the loopback anvil and chain the caller named; nothing is left running
 */
export async function attachForkPoolEnv(o: AttachForkOptions): Promise<ForkPoolEnv> {
	const { rpcUrl, clientVersion, chainId, deployment, postman, circuitsDir, circuitBundle, runId } = o
	await assertForkNode(rpcUrl, clientVersion, chainId)
	const aspRun = `${runId}-pool`
	const port = await claimPort(aspRun, "pp-env-asp")
	const asp = await startEvmMockAsp({
		rpcUrl,
		chainId,
		aspRegistryAddress: deployment.aspRegistry,
		entrypointAddress: deployment.entrypoint,
		signer: { kind: "impersonate", address: postman },
		forkMode: true,
		// Nothing can predate the deployment, so discovery scans only from there; anvil serves that range from upstream.
		eventSource: new EvmDeploymentSnapshotSource({ chainId, deploymentBlock: deployment.deployBlock }),
		host: "127.0.0.1",
		port,
	}).catch(async (err: unknown) => {
		await releasePorts(aspRun)
		throw err
	})
	const clientConfig: ClientConfig = {
		rpcUrl,
		chainId,
		deployment: { ...deployment },
		aspUrl: asp.url,
		circuitsDir,
		...(circuitBundle && { circuitBundle }),
	}
	let stopped: Promise<void> | undefined
	return {
		clientConfig,
		asp: {
			url: asp.url,
			approveLabel: async (label) => BigInt((await asp.approveLabel(toHex(label))).root),
		},
		stop: () => {
			stopped ??= stopAsp(asp).finally(() => releasePorts(aspRun))
			return stopped
		},
	}
}
