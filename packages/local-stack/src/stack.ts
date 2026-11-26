import { type LocalNetwork, startLocalNetwork } from "@pp/bridge-core/sandbox"
import { type PoolEnv, startPoolEnv } from "@pp/pp-env"
import { type Address, createPublicClient, http, type PublicClient } from "viem"
import { nodeInfo } from "./node-rpc.ts"
import { Teardown } from "./teardown.ts"

export const STACK_CHAIN_ID = 31337
/** pp-env's default deployer; bridge-core's harness and actors sit at 15 and from 1 up. */
const POOL_DEPLOYER_INDEX = 14

export type StepName = "network" | "pool" | "manifest" | "heartbeat"

export type StartStackOptions = {
	/** Checked between steps; a step already starting runs to the end first, since neither harness can be cancelled mid-start. */
	signal?: AbortSignal
	/** Progress for the CLI; a throw aborts the boot. */
	onStep?: (s: { step: StepName; seconds: number }) => void | Promise<void>
}

export interface Stack {
	runId: string
	l1Rpc: string
	aztecNode: string
	/** pp-env's handle, for in-process tests (createUser, deployStub). */
	pool: PoolEnv
	/** Idempotent; stops the pool, then the network. */
	stop(): Promise<void>
}

/** The attach variables make scaffold's harness reuse whatever chain they name, and the pool would then be deployed onto it. */
export class AttachRefused extends Error {
	constructor(names: string[]) {
		super(
			`${names.join(" and ")} ${names.length > 1 ? "are" : "is"} set, as a kept stack prints them for scaffold-harness suites. ` +
				"The stack always boots its own network: run `unset SANDBOX_L1_RPC SANDBOX_NODE_URL` first.",
		)
		this.name = "AttachRefused"
	}
}

function refuseAttach(): void {
	const set = ["SANDBOX_L1_RPC", "SANDBOX_NODE_URL"].filter((k) => process.env[k])
	if (set.length) throw new AttachRefused(set)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new Error("aborted")
}

async function runStep<T>(o: StartStackOptions, step: StepName, start: () => Promise<T>, register: (h: T) => void): Promise<T> {
	throwIfAborted(o.signal)
	const t0 = performance.now()
	const handle = await start()
	register(handle)
	throwIfAborted(o.signal)
	await o.onStep?.({ step, seconds: (performance.now() - t0) / 1000 })
	return handle
}

async function stopNetwork(net: LocalNetwork): Promise<void> {
	await net.stop()
	const left = net.leftovers()
	if (left.length) throw new Error(`network left behind: ${left.join("; ")}`)
}

/** The stack is ready once both halves still answer on the shared anvil. */
async function assertReady(client: PublicClient, nodeUrl: string, pool: PoolEnv): Promise<void> {
	const info = await nodeInfo(nodeUrl)
	if (info.l1ChainId !== STACK_CHAIN_ID) throw new Error(`node reports L1 chain ${info.l1ChainId}, not ${STACK_CHAIN_ID}`)
	const { accessRouter, keystore, aspRegistry, pool: poolVault, entrypoint, relay } = pool.deployment
	const contracts: Record<string, Address> = {
		rollup: info.l1ContractAddresses.rollupAddress,
		accessRouter,
		keystore,
		aspRegistry,
		poolVault,
		entrypoint,
		relay,
		asset: pool.asset,
	}
	const codeless = await Promise.all(
		Object.entries(contracts).map(async ([name, address]) => ((await client.getCode({ address })) ? undefined : `${name} ${address}`)),
	)
	const missing = codeless.filter((m) => m !== undefined)
	if (missing.length) throw new Error(`no code at ${missing.join(", ")}`)
	const asp = await fetch(pool.asp.url).catch((err: unknown) => {
		throw new Error(`mock ASP at ${pool.asp.url} refused: ${err instanceof Error ? err.message : String(err)}`)
	})
	await asp.body?.cancel()
}

/**
 * Boots one anvil carrying both the Aztec local network and the pool. Anything started is torn
 * down again when a later step fails or `signal` aborts between steps.
 */
export async function startStack(o: StartStackOptions = {}): Promise<Stack> {
	refuseAttach()
	const runId = `stack-${process.pid}-${Date.now().toString(36)}`
	const teardown = new Teardown()
	try {
		const net = await runStep(
			o,
			"network",
			() => startLocalNetwork({ runId, signals: false }),
			(n) => teardown.push("network", () => stopNetwork(n)),
		)
		console.log(`[stack] pool starting on ${net.anvilUrl}`)
		const pool = await runStep(
			o,
			"pool",
			() => startPoolEnv({ rpcUrl: net.anvilUrl, deployerIndex: POOL_DEPLOYER_INDEX, runId: `${runId}-pool`, signals: false }),
			(p) => teardown.push("pool", () => p.stop()),
		)
		const client = createPublicClient({ transport: http(net.anvilUrl) })
		await assertReady(client, net.nodeUrl, pool)
		return { runId, l1Rpc: net.anvilUrl, aztecNode: net.nodeUrl, pool, stop: () => teardown.run() }
	} catch (err) {
		await teardown.run().catch((e: unknown) => console.warn(`[stack] ${runId}: teardown after a failed boot also failed`, e))
		throw err
	}
}
