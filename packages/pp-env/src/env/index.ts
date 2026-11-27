import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, rm, rmdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { EvmDeploymentSnapshotSource, startEvmMockAsp } from "#ppv2/mock-asp/evm"
import { createPublicClient, createWalletClient, type Hex, http, type PublicClient, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { createPoolUser } from "../client/pool.ts"
import type { ClientConfig, LocalWallet } from "../client/types.ts"
import { checkout } from "./checkout.ts"
import { deployFixture, deployPool, enableAsset, ensureFixtures, installPoseidon, mintTestToken } from "./deploy.ts"
import { verifyFetched } from "./fetch/index.ts"
import { anvilKey, attachAnvil, CHAIN_ID, DEPLOYER_INDEX, startAnvil } from "./harness/anvil.ts"
import { claimPort, releasePorts } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import type { PoolEnv, StartPoolEnvOptions } from "./types.ts"
import { submitViaStub } from "./stub.ts"
import { stopAsp } from "./asp.ts"

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

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * Two environments sharing a run ID would tear down each other's ports and files, so the run
 * directory is created exclusively and an existing one is never taken over: deciding that its
 * owner is gone would race another process deciding the same.
 */
function reserveRunDir(runId: string, runDir: string): void {
	mkdirSync(RUNS_DIR, { recursive: true })
	try {
		mkdirSync(runDir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
		const owner = Number.parseInt(existsSync(join(runDir, "owner")) ? readFileSync(join(runDir, "owner"), "utf8") : "", 10)
		const by = Number.isInteger(owner) ? (alive(owner) ? `process ${owner}` : `process ${owner}, which has exited`) : "an earlier run"
		throw new Error(`runId ${runId} is in use by ${by}: pick another, or remove ${runDir} if nothing uses it`)
	}
	writeFileSync(join(runDir, "owner"), String(process.pid))
}

/** Brings up the pool on a local anvil; anything started is torn down again if a later step fails. */
export async function startPoolEnv(o: StartPoolEnvOptions = {}): Promise<PoolEnv> {
	const runId = o.runId ?? `pp-env-${process.pid}-${randomBytes(3).toString("hex")}`
	if (!RUN_ID.test(runId)) throw new Error(`runId ${JSON.stringify(runId)} must match ${RUN_ID}`)
	const runDir = join(RUNS_DIR, runId)
	const forgeDir = join(runDir, "forge")
	reserveRunDir(runId, runDir)
	const cleanup = new CleanupStack({ signals: o.signals })
	cleanup.push(async () => {
		await rm(forgeDir, { recursive: true, force: true })
		await rm(join(runDir, "owner"), { force: true })
		// Kept when a caller left files in it, such as measurements.
		await rmdir(runDir).catch(() => {})
	})
	cleanup.push(() => releasePorts(runId))
	try {
		const co = checkout()
		await verifyFetched(co.target)
		await mkdir(forgeDir)
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
