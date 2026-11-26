import { rm } from "node:fs/promises"
import { join } from "node:path"
import { type StackManifest, serializeStackManifest } from "@pp/bridge-core"
import { type LocalNetwork, startLocalNetwork } from "@pp/bridge-core/sandbox"
import { type PoolEnv, startPoolEnv } from "@pp/pp-env"
import { type Address, createPublicClient, http, type PublicClient } from "viem"
import { refuseAttach } from "./attach.ts"
import { BeatPolicy, type ChainView, type L1Tx } from "./beat-policy.ts"
import { type Heartbeat, startHeartbeat } from "./heartbeat.ts"
import { buildManifest } from "./manifest.ts"
import { nodeInfo, nodeRpc } from "./node-rpc.ts"
import { createRunDir, newRunId, RUNS_DIR, removeRunDir, writeAtomic } from "./run-dir.ts"
import { Teardown } from "./teardown.ts"

export const STACK_CHAIN_ID = 31337
export const HEARTBEAT_MS = 120_000
/** The node answers a mine within a second; a beat open this long is logged as stuck. */
const LATE_BEAT_MS = 180_000
const STOP_WAIT_MS = 60_000
/** pp-env's default deployer; bridge-core's harness and actors sit at 15 and from 1 up. */
const POOL_DEPLOYER_INDEX = 14
export type StepName = "network" | "pool" | "manifest" | "heartbeat"

export type StartStackOptions = {
	runId?: string
	/** Parent of the run directory; defaults to `~/.cache/pp/runs`. */
	runsDir?: string
	/** Default true. Off, no block is mined unless a consumer asks for one. */
	heartbeat?: boolean
	/** Tick spacing; only tests shorten it. */
	heartbeatMs?: number
	/** Checked between steps; a step already starting runs to the end first, since neither harness can be cancelled mid-start. */
	signal?: AbortSignal
	/** Progress for the CLI; a throw aborts the boot. */
	onStep?: (s: { step: StepName; seconds: number }) => void | Promise<void>
}

export interface Stack {
	runId: string
	manifestPath: string
	manifest: StackManifest
	/** pp-env's handle, for in-process tests (createUser, deployStub). */
	pool: PoolEnv
	/** Idempotent; stops the heartbeat, withdraws the manifest, then stops the pool and the network. */
	stop(): Promise<void>
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
	throwIfAborted(o.signal)
	return handle
}

async function stopNetwork(net: LocalNetwork): Promise<void> {
	await net.stop()
	const left = net.leftovers()
	if (left.length) throw new Error(`network left behind: ${left.join("; ")}`)
}

/** The stack is ready once both halves still answer on the shared anvil. */
async function assertReady(client: PublicClient, nodeUrl: string, pool: PoolEnv, signal?: AbortSignal): Promise<void> {
	const info = await nodeInfo(nodeUrl, signal)
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
	const health = new URL("/health", pool.asp.url)
	const asp = await fetch(health, { signal }).catch((err: unknown) => {
		throw new Error(`mock ASP at ${health} refused: ${err instanceof Error ? err.message : String(err)}`)
	})
	await asp.body?.cancel()
	if (!asp.ok) throw new Error(`mock ASP at ${health} answered HTTP ${asp.status}`)
}

type ChainTips = { checkpointed: { block: { number: number } } }
type BlockData = { header: { totalManaUsed: string } }

/** viem's transport bounds every L1 read; `signal` bounds the node's, which have no timeout. */
function chainView(client: PublicClient, nodeUrl: string, signal?: AbortSignal): ChainView {
	return {
		l1Head: () => client.getBlockNumber({ cacheTime: 0 }),
		l1Hash: async (n) => (await client.getBlock({ blockNumber: n })).hash,
		l1Txs: async (n) =>
			(await client.getBlock({ blockNumber: n, includeTransactions: true })).transactions.map((t) => ({
				from: t.from.toLowerCase(),
				to: t.to?.toLowerCase() ?? null,
			})),
		aztecTip: async () => (await nodeRpc<ChainTips>(nodeUrl, "node_getChainTips", [], signal)).checkpointed.block.number,
		// Every transaction spends mana, so an empty block is exactly one with none used.
		aztecHasTxs: async (n) => BigInt((await nodeRpc<BlockData>(nodeUrl, "node_getBlockData", [n], signal)).header.totalManaUsed) > 0n,
	}
}

const mineBlock = (nodeUrl: string, signal?: AbortSignal) => nodeRpc<null>(nodeUrl, "aztecDebug_mineBlock", [], signal)

/**
 * The first beat is part of readiness, so a renamed debug method fails the boot. Its propose
 * transaction also names the node's sender and target, which the policy must not count as work.
 */
async function firstBeat(client: PublicClient, nodeUrl: string, signal?: AbortSignal): Promise<BeatPolicy> {
	const view = chainView(client, nodeUrl, signal)
	const [head, tip] = [await view.l1Head(), await view.aztecTip()]
	await mineBlock(nodeUrl, signal)
	if ((await view.aztecTip()) <= tip) throw new Error("aztecDebug_mineBlock returned without a new checkpointed block")
	const txs = new Map<string, L1Tx>()
	for (let n = head + 1n, last = await view.l1Head(); n <= last; n++) for (const t of await view.l1Txs(n)) txs.set(`${t.from}>${t.to}`, t)
	const [nodeTx, ...others] = txs.values()
	if (!nodeTx || others.length)
		throw new Error(`the first beat's L1 transactions are [${[...txs.keys()].join(", ")}]; expected one propose`)
	const policy = new BeatPolicy(chainView(client, nodeUrl), nodeTx)
	await policy.start()
	return policy
}

function beatEvery(intervalMs: number, nodeUrl: string, policy: BeatPolicy): Heartbeat {
	return startHeartbeat({
		intervalMs,
		slowMs: LATE_BEAT_MS,
		stopWaitMs: STOP_WAIT_MS,
		log: (line) => console.warn(line),
		due: () => policy.due(),
		beat: (signal) => policy.beat(() => mineBlock(nodeUrl, signal)),
	})
}

/**
 * Boots one anvil carrying both the Aztec local network and the pool, writes the manifest once the
 * stack is ready, and keeps blocks coming while work waits on them. Anything started is torn down
 * again when a later step fails or `signal` aborts between steps.
 * @throws AttachRefused when `SANDBOX_L1_RPC` or `SANDBOX_NODE_URL` is set.
 */
export async function startStack(o: StartStackOptions = {}): Promise<Stack> {
	const runId = o.runId ?? newRunId()
	const teardown = new Teardown()
	try {
		const runDir = await createRunDir(o.runsDir ?? RUNS_DIR, runId)
		teardown.push("run dir", () => removeRunDir(runDir))
		const net = await runStep(
			o,
			"network",
			// Checked with no await before the harness reads the same variables.
			() => {
				refuseAttach()
				return startLocalNetwork({ runId, signals: false })
			},
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
		await assertReady(client, net.nodeUrl, pool, o.signal)
		const policy = o.heartbeat === false ? undefined : await firstBeat(client, net.nodeUrl, o.signal)
		const { pool: poolVault, entrypoint, aspRegistry, keystore, deployBlock } = pool.deployment
		const manifest = buildManifest({
			chainId: STACK_CHAIN_ID,
			l1Rpc: net.anvilUrl,
			aztecNode: net.nodeUrl,
			pool: { poolVault, entrypoint, aspRegistry, keystore, deployBlock },
			asset: pool.asset,
			aspUrl: pool.asp.url,
		})
		const manifestPath = join(runDir, "manifest.json")
		await runStep(
			o,
			"manifest",
			() => writeAtomic(manifestPath, serializeStackManifest(manifest)),
			() => teardown.push("manifest", () => rm(manifestPath, { force: true })),
		)
		if (policy)
			await runStep(
				o,
				"heartbeat",
				async () => beatEvery(o.heartbeatMs ?? HEARTBEAT_MS, net.nodeUrl, policy),
				(hb) => teardown.push("heartbeat", () => hb.stop()),
			)
		return { runId, manifestPath, manifest, pool, stop: () => teardown.run() }
	} catch (err) {
		await teardown.run().catch((e: unknown) => console.warn(`[stack] ${runId}: teardown after a failed boot also failed`, e))
		throw err
	}
}
