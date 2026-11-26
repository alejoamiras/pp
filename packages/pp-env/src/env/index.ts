import { randomBytes } from "node:crypto"
import { mkdir, rm, rmdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { EvmDeploymentSnapshotSource, startEvmMockAsp } from "@ppv2/mock-asp/evm"
import { type Address, createPublicClient, createWalletClient, type Hex, http, type PublicClient, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { createPoolUser } from "../client/pool.ts"
import type { ClientConfig, LocalWallet } from "../client/types.ts"
import { checkout } from "./checkout.ts"
import { deployFixture, deployPool, enableAsset, ensureFixtures, installPoseidon, mintTestToken } from "./deploy.ts"
import { verifyFetched } from "./fetch/index.ts"
import { anvilKey, attachAnvil, CHAIN_ID, DEPLOYER_INDEX, startAnvil } from "./harness/anvil.ts"
import { claimPort, releasePorts } from "./harness/ports.ts"
import { CleanupStack } from "./harness/process.ts"
import type { PoolEnv, StartPoolEnvOptions } from "./types.ts"
import { submitViaStub } from "./stub.ts"

export type { LocalChainId, PoolDeployment, PoolEnv, StartPoolEnvOptions } from "./types.ts"

export const RUNS_DIR = join(homedir(), ".cache/pp/pp-env/runs")
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function localClients(rpcUrl: string, key: Hex): { client: PublicClient; wallet: LocalWallet } {
	const chain = { ...foundry, rpcUrls: { default: { http: [rpcUrl] } } }
	const transport = http(rpcUrl)
	const client = createPublicClient({ chain, transport, pollingInterval: 100 }) as PublicClient
	const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(key) })
	return { client, wallet }
}

/**
 * Bun 1.4.2's `closeAllConnections()` also stops the listener (Node's does not), so the mock ASP's
 * `stop()` then fails in `close()` although its port is already free. Accepted only once the port refuses.
 */
async function stopAsp(asp: { url: string; stop(): Promise<void> }): Promise<void> {
	try {
		await asp.stop()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw err
		if (
			await fetch(asp.url).then(
				() => true,
				() => false,
			)
		)
			throw err
	}
}

/** Brings up the pool on a local anvil; anything started is torn down again if a later step fails. */
export async function startPoolEnv(o: StartPoolEnvOptions = {}): Promise<PoolEnv> {
	const runId = o.runId ?? `pp-env-${process.pid}-${randomBytes(3).toString("hex")}`
	if (!RUN_ID.test(runId)) throw new Error(`runId ${JSON.stringify(runId)} must match ${RUN_ID}`)
	const runDir = join(RUNS_DIR, runId)
	const forgeDir = join(runDir, "forge")
	const cleanup = new CleanupStack({ signals: o.signals })
	cleanup.push(() => releasePorts(runId))
	cleanup.push(async () => {
		await rm(forgeDir, { recursive: true, force: true })
		await rmdir(runDir).catch(() => {})
	})
	try {
		const co = checkout()
		await verifyFetched(co.target)
		await mkdir(forgeDir, { recursive: true })
		await ensureFixtures()
		const rpcUrl = o.rpcUrl ? await attachAnvil(o.rpcUrl) : await startAnvil(runId, cleanup)
		const deployerIndex = o.deployerIndex ?? DEPLOYER_INDEX
		const deployerKey = anvilKey(deployerIndex)
		const { client, wallet } = localClients(rpcUrl, deployerKey)
		const deployer = wallet.account.address
		await installPoseidon(rpcUrl, co)
		const deployment = await deployPool({ rpcUrl, co, deployerKey, deployer, workDir: forgeDir, client })
		const asset = await deployFixture(wallet, client, "TestToken")
		await enableAsset(wallet, client, deployment.entrypoint, asset)
		const asp = await startEvmMockAsp({
			rpcUrl,
			chainId: CHAIN_ID,
			aspRegistryAddress: deployment.aspRegistry,
			entrypointAddress: deployment.entrypoint,
			signer: { kind: "privateKey", privateKey: deployerKey },
			eventSource: new EvmDeploymentSnapshotSource({ chainId: CHAIN_ID, deploymentBlock: deployment.deployBlock }),
			host: "127.0.0.1",
			port: await claimPort(runId, "pp-env-asp"),
		})
		cleanup.push(() => stopAsp(asp))
		const { pool, entrypoint, keystore, aspRegistry, deployBlock } = deployment
		const clientConfig: ClientConfig = {
			rpcUrl,
			chainId: CHAIN_ID,
			deployment: { pool, entrypoint, keystore, aspRegistry, deployBlock },
			aspUrl: asp.url,
			circuitsDir: co.circuits,
		}
		const walletAt = (index: number) => localClients(rpcUrl, anvilKey(index)).wallet
		return {
			runId,
			rpcUrl,
			chainId: CHAIN_ID,
			deployment,
			asset,
			deployerIndex,
			asp: {
				url: asp.url,
				approveLabel: async (label) => BigInt((await asp.approveLabel(toHex(label))).root),
			},
			clientConfig,
			createUser: ({ accountIndex, signature }) => createPoolUser(clientConfig, { wallet: walletAt(accountIndex), signature }),
			mint: (to, amount) => mintTestToken(wallet, client, asset, to, amount),
			deployStub: () => deployFixture(wallet, client, "StubProcessor", [deployment.pool, asset]),
			submitViaStub: (stub, spend, fromIndex) => submitViaStub(walletAt(fromIndex), client, stub, spend),
			stop: () => cleanup.run(),
		}
	} catch (err) {
		await cleanup.run().catch((e) => console.warn(`[pp-env] ${runId}: cleanup after a failed start also failed`, e))
		throw err
	}
}
