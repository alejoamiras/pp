import { rm } from "node:fs/promises"
import { join } from "node:path"
import { type BotHandle, localBotAccounts, startBot } from "@pp/asp-bot"
import { type StackManifest, serializeStackManifest } from "@pp/bridge-core"
import {
	deployBridgeGeneration,
	type ExpectedBindings,
	openBridgeEntries,
	type StackBridgeBlock,
	type UnopenedBridge,
} from "@pp/bridge-core/deploy"
import { anvilKey, HARNESS_INDEX, type LocalNetwork, startLocalNetwork } from "@pp/bridge-core/sandbox"
import { type PoolEnv, startPoolEnv } from "@pp/pp-env"
import { type Address, createPublicClient, http, maxUint256, type PublicClient } from "viem"
import { refuseAttach } from "./attach.ts"
import { BeatPolicy, type ChainView, type L1Tx } from "./beat-policy.ts"
import { type Heartbeat, startHeartbeat } from "./heartbeat.ts"
import { buildManifest } from "./manifest.ts"
import { nodeInfo, nodeRpc } from "./node-rpc.ts"
import { assertPrerequisites } from "./prerequisites.ts"
import { createRunDir, newRunId, RUNS_DIR, removeRunDir, writeAtomic } from "./run-dir.ts"
import { type Seeded, seedPool } from "./seed.ts"
import { Teardown } from "./teardown.ts"

export const STACK_CHAIN_ID = 31337
/** A tick only checks for owed beats and never ages the chain, so it can be short: a claim waits about two ticks. */
export const HEARTBEAT_MS = 2_000
/** The node answers a mine within a second; a beat open this long is logged as stuck. */
const LATE_BEAT_MS = 180_000
const STOP_WAIT_MS = 60_000
/** pp-env's default deployer; bridge-core's harness and actors sit at 15 and from 1 up. */
export const POOL_DEPLOYER_INDEX = 14
/** The bridge's owner and guardian: bridge-core's harness index, below pp-env's deployer and above the actors. */
export const BRIDGE_DEPLOYER_INDEX = HARNESS_INDEX
/** Covers the post's inclusion after its read; a local post lands about 150 s of chain time later. */
const BOT_INCLUSION_MARGIN_SEC = 300
export type StepName = "network" | "pool" | "bridge" | "seed" | "bot" | "manifest" | "heartbeat"

export type StartStackOptions = {
	/** Defaults to a fresh `stack-<pid>-<time>`; a chosen one must be unique on the host (see the README's teardown notes). */
	runId?: string
	/** Parent of the run directory; defaults to `~/.cache/pp/runs`. */
	runsDir?: string
	/** Default true. Off, no beat runs after the boot; the boot's own mines and a bot's posts still make blocks. */
	heartbeat?: boolean
	/**
	 * Default true. Off, the bridge gets no ASP registry and no bot runs, so no heartbeat post adds
	 * blocks to a chain a caller counts.
	 */
	bot?: boolean
	/** Tick spacing; defaults to `HEARTBEAT_MS`. */
	heartbeatMs?: number
	/**
	 * Checked between steps and by the bot while it starts; any other step already starting runs to its
	 * end first, since neither harness can be cancelled mid-start.
	 */
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
	/** The demo's pool user and its separate Ethereum sender. */
	seeded: Seeded
	/**
	 * Idempotent; stops the heartbeat, withdraws the manifest, stops the bot, then the bridge's PXE,
	 * the pool and the network.
	 */
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

type NodeTips = { checkpointed: { block: { number: number; hash: string } }; proven: { block: { number: number } } }
type BlockData = { header: { totalManaUsed: string } }

/** viem's default transport timeout, so a stalled node read fails like a stalled L1 read and the next tick retries. */
const NODE_READ_MS = 10_000

/** `signal` also cuts the node reads short; mining stays outside, since the node keeps a request the client gave up on. */
function chainView(client: PublicClient, nodeUrl: string, signal?: AbortSignal): ChainView {
	const read = <T>(method: string, params: unknown[] = []) =>
		nodeRpc<T>(nodeUrl, method, params, AbortSignal.any([AbortSignal.timeout(NODE_READ_MS), ...(signal ? [signal] : [])]))
	return {
		l1Head: () => client.getBlockNumber({ cacheTime: 0 }),
		l1Hash: async (n) => (await client.getBlock({ blockNumber: n })).hash,
		l1Txs: async (n) =>
			(await client.getBlock({ blockNumber: n, includeTransactions: true })).transactions.map((t) => ({
				from: t.from.toLowerCase(),
				to: t.to?.toLowerCase() ?? null,
			})),
		aztecTips: async () => {
			const t = await read<NodeTips>("node_getChainTips")
			return { checkpointed: t.checkpointed.block, proven: t.proven.block.number }
		},
		// Every transaction spends mana, so an empty block is exactly one with none used.
		aztecHasTxs: async (n) => BigInt((await read<BlockData>("node_getBlockData", [n])).header.totalManaUsed) > 0n,
	}
}

const mineBlock = (nodeUrl: string, signal?: AbortSignal) => nodeRpc<null>(nodeUrl, "aztecDebug_mineBlock", [], signal)

/**
 * The first beat is part of readiness, so a renamed debug method fails the boot. Its propose
 * transaction also names the node's sender and target, which the policy must not count as work.
 */
async function firstBeat(client: PublicClient, nodeUrl: string, signal?: AbortSignal): Promise<BeatPolicy> {
	const view = chainView(client, nodeUrl, signal)
	const tip = async () => (await view.aztecTips()).checkpointed.number
	const [head, before] = [await view.l1Head(), await tip()]
	await mineBlock(nodeUrl, signal)
	if ((await tip()) <= before) throw new Error("aztecDebug_mineBlock returned without a new checkpointed block")
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

/** Test seams on the real boot path; module-internal, never exported from the package. */
export type BootFaults = {
	/** Maps the expectations the bridge read-back checks, so a case can make it fail. */
	bridgeExpectations?: (e: ExpectedBindings) => ExpectedBindings
	/** Runs after the bridge read-back failed and before teardown. */
	onBridgeFailure?: (u: UnopenedBridge) => void | Promise<void>
}

type Booted = { runId: string; runDir: string; net: LocalNetwork; pool: PoolEnv }

/**
 * Deploys the generation with entries paused, hands its PXE to the teardown the moment it exists,
 * and opens entries only after the read-back agrees. Blocks come from the orchestrator's own mine:
 * the heartbeat starts after the manifest.
 */
async function bridgeStep(o: StartStackOptions, faults: BootFaults, b: Booted, teardown: Teardown): Promise<StackBridgeBlock> {
	const u = await deployBridgeGeneration({
		l1Rpc: b.net.anvilUrl,
		aztecNode: b.net.nodeUrl,
		chainId: STACK_CHAIN_ID,
		pool: { poolVault: b.pool.deployment.pool, asset: b.pool.asset },
		deployerKey: anvilKey(BRIDGE_DEPLOYER_INDEX),
		lifetimeCap: maxUint256,
		forceBlock: async () => {
			await mineBlock(b.net.nodeUrl, o.signal)
		},
		dataDir: join(b.runDir, "bridge"),
		...(o.bot === false ? {} : { registry: await localBotAccounts(b.runId) }),
	})
	teardown.push("bridge deployer", () => u.stop())
	try {
		return await openBridgeEntries(u, faults.bridgeExpectations?.(u.expected) ?? u.expected)
	} catch (err) {
		await faults.onBridgeFailure?.(u)
		throw err
	}
}

async function bootChains(o: StartStackOptions, runId: string, teardown: Teardown): Promise<Booted> {
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
	return { runId, runDir, net, pool }
}

/**
 * Resolves once the bot's first post has landed, so the manifest never names a bot that cannot post.
 * It needs no beat: the local network builds a block for each pending transaction.
 */
function botStep(o: StartStackOptions, b: Booted, bridge: StackBridgeBlock): Promise<BotHandle> {
	return startBot(
		{
			manifest: {
				l1Rpc: b.net.anvilUrl,
				aztecNode: b.net.nodeUrl,
				pool: { aspRegistry: b.pool.deployment.aspRegistry, aspApiUrl: b.pool.asp.url },
			},
			registry: bridge.registry,
			tokens: [bridge.token],
			tag: "latest",
			stackRunId: b.runId,
			runId: `${b.runId}-bot`,
			dataDir: join(b.runDir, "bot"),
			inclusionMarginSec: BOT_INCLUSION_MARGIN_SEC,
		},
		{ removeDataOnStop: true, ...(o.signal ? { signal: o.signal } : {}) },
	)
}

function manifestOf(b: Booted, bridge: StackBridgeBlock, bot: BotHandle | undefined): StackManifest {
	const { pool: poolVault, entrypoint, aspRegistry, keystore, deployBlock } = b.pool.deployment
	return buildManifest({
		chainId: STACK_CHAIN_ID,
		l1Rpc: b.net.anvilUrl,
		aztecNode: b.net.nodeUrl,
		pool: { poolVault, entrypoint, aspRegistry, keystore, deployBlock },
		asset: b.pool.asset,
		aspUrl: b.pool.asp.url,
		bridge,
		...(bot ? { bot: { url: bot.url, poster: bot.poster, birthIntake: bot.birthIntake } } : {}),
	})
}

/** `startStack` with test seams; see `BootFaults`. */
export async function bootStack(o: StartStackOptions, faults: BootFaults): Promise<Stack> {
	assertPrerequisites()
	const runId = o.runId ?? newRunId()
	const teardown = new Teardown()
	try {
		const b = await bootChains(o, runId, teardown)
		const client = createPublicClient({ transport: http(b.net.anvilUrl) })
		await assertReady(client, b.net.nodeUrl, b.pool, o.signal)
		const policy = o.heartbeat === false ? undefined : await firstBeat(client, b.net.nodeUrl, o.signal)
		const bridge = await runStep(
			o,
			"bridge",
			() => bridgeStep(o, faults, b, teardown),
			() => {},
		)
		const seeded = await runStep(
			o,
			"seed",
			() => seedPool(b.pool),
			() => {},
		)
		const bot =
			o.bot === false
				? undefined
				: await runStep(
						o,
						"bot",
						() => botStep(o, b, bridge),
						(h) => teardown.push("bot", () => h.stop()),
					)
		const manifest = manifestOf(b, bridge, bot)
		const manifestPath = join(b.runDir, "manifest.json")
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
				async () => beatEvery(o.heartbeatMs ?? HEARTBEAT_MS, b.net.nodeUrl, policy),
				(hb) => teardown.push("heartbeat", () => hb.stop()),
			)
		return { runId, manifestPath, manifest, pool: b.pool, seeded, stop: () => teardown.run() }
	} catch (err) {
		await teardown.run().catch((e: unknown) => console.warn(`[stack] ${runId}: teardown after a failed boot also failed`, e))
		throw err
	}
}

/**
 * Boots one anvil carrying both the Aztec local network and the pool, opens the bridge, seeds the
 * demo user, starts the ASP bot on the bridge's registry, writes the manifest once the stack is
 * ready, and keeps blocks coming while work waits on them. Anything started is torn down again
 * when a later step fails or `signal` aborts between steps.
 * @throws Error naming `bun run demo:prepare`, before anything starts, when pp-env's checkout or
 *   the forge artifacts are missing
 * @throws AttachRefused when `SANDBOX_L1_RPC` or `SANDBOX_NODE_URL` is set.
 */
export function startStack(o: StartStackOptions = {}): Promise<Stack> {
	return bootStack(o, {})
}
