import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { anvilKey } from "@pp/pp-env"
import { createPublicClient, createWalletClient, type Hex, http, parseEventLogs, type PublicClient, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { nodeInfo, nodeRpc } from "../../src/node-rpc.ts"
import { type Stack, startStack } from "../../src/stack.ts"

const TICK_MS = 10_000
/** Eighteen ticks: a self-triggering guard would have mined within the first two. */
const IDLE_MS = 180_000
const SENDER_INDEX = 10

const INBOX_ABI = [
	{
		type: "function",
		name: "sendL2Message",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "_recipient",
				type: "tuple",
				components: [
					{ name: "actor", type: "bytes32" },
					{ name: "version", type: "uint256" },
				],
			},
			{ name: "_content", type: "bytes32" },
			{ name: "_secretHash", type: "bytes32" },
		],
		outputs: [
			{ name: "", type: "bytes32" },
			{ name: "", type: "uint256" },
		],
	},
	{
		type: "event",
		name: "MessageSent",
		inputs: [
			{ name: "hash", type: "bytes32", indexed: true },
			{ name: "inboxRollingHash", type: "bytes32", indexed: false },
			{ name: "bucketSeq", type: "uint256", indexed: false },
			{
				name: "message",
				type: "tuple",
				indexed: false,
				components: [
					{
						name: "sender",
						type: "tuple",
						components: [
							{ name: "actor", type: "address" },
							{ name: "chainId", type: "uint256" },
						],
					},
					{
						name: "recipient",
						type: "tuple",
						components: [
							{ name: "actor", type: "bytes32" },
							{ name: "version", type: "uint256" },
						],
					},
					{ name: "content", type: "bytes32" },
					{ name: "secretHash", type: "bytes32" },
					{ name: "index", type: "uint256" },
				],
			},
		],
	},
] as const

type Tips = { checkpointed: number; finalized: number }
type L1ToL2Index = string | number | null | undefined

/** Polls `check` every second until it holds or `ms` passes; returns whether it held. */
async function within(ms: number, check: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + ms
	for (;;) {
		if (await check()) return true
		if (Date.now() > deadline) return false
		await Bun.sleep(1000)
	}
}

describe.skipIf(!process.env.PP_STACK_INTEGRATION)("the heartbeat mines only for work that waits on blocks", () => {
	let stack: Stack
	let client: PublicClient
	const tips = async (): Promise<Tips> => {
		const t = await nodeRpc<{ checkpointed: { block: { number: number } }; finalized: { block: { number: number } } }>(
			stack.manifest.aztecNode,
			"node_getChainTips",
		)
		return { checkpointed: t.checkpointed.block.number, finalized: t.finalized.block.number }
	}
	const frozen = async () => ({ l1: await client.getBlockNumber({ cacheTime: 0 }), aztec: (await tips()).checkpointed })

	beforeAll(async () => {
		stack = await startStack({ heartbeatMs: TICK_MS })
		client = createPublicClient({ transport: http(stack.manifest.l1Rpc) })
		// The boot owes one beat after readiness's; let it land.
		await Bun.sleep(TICK_MS * 2)
	})

	afterAll(async () => {
		await stack?.stop()
	})

	test("an idle stack stays frozen: the beats' own Ethereum blocks never count as work", async () => {
		const before = await frozen()
		await Bun.sleep(IDLE_MS)
		expect(await frozen()).toEqual(before)
	})

	/**
	 * Sends one L1→L2 message from an account no stack actor uses and returns its leaf hash.
	 * `rightAfter` runs as soon as anvil has the transaction, before the node can have read it.
	 */
	const sendMessage = async (rightAfter?: () => Promise<unknown>): Promise<Hex> => {
		const info = await nodeInfo(stack.manifest.aztecNode)
		const wallet = createWalletClient({
			chain: { ...foundry, rpcUrls: { default: { http: [stack.manifest.l1Rpc] } } },
			transport: http(stack.manifest.l1Rpc),
			account: privateKeyToAccount(anvilKey(SENDER_INDEX)),
		})
		const hash = await wallet.writeContract({
			address: info.l1ContractAddresses.inboxAddress,
			abi: INBOX_ABI,
			functionName: "sendL2Message",
			args: [
				{ actor: `0x${"11".repeat(32)}`, version: BigInt(info.rollupVersion) },
				`0x${"00".repeat(31)}2a`,
				toHex(++nonce, { size: 32 }),
			],
		})
		await rightAfter?.()
		const logs = (await client.waitForTransactionReceipt({ hash, pollingInterval: 100 })).logs
		const [sent] = parseEventLogs({ abi: INBOX_ABI, logs, eventName: "MessageSent" })
		if (!sent) throw new Error("no MessageSent in the receipt")
		return sent.args.hash
	}
	/** Whether `leaf` is in the message tree of checkpointed block `block`, which is when a claim may consume it. */
	const consumableAt = async (leaf: Hex, block: number) => {
		const index = await nodeRpc<L1ToL2Index>(stack.manifest.aztecNode, "node_getL1ToL2MessageIndex", [leaf])
		const data = await nodeRpc<{ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: number } } } }>(
			stack.manifest.aztecNode,
			"node_getBlockData",
			[block],
		)
		return index !== null && index !== undefined && BigInt(data.header.state.l1ToL2MessageTree.nextAvailableLeafIndex) > BigInt(index)
	}
	const consumableNow = async (leaf: Hex) => consumableAt(leaf, (await tips()).checkpointed)
	let nonce = 0
	/** The movement owes exactly two beats; once they have landed, nothing else is mined. */
	const expectOwedBeatsThenFrozen = async (from: number) => {
		await Bun.sleep(TICK_MS * 2)
		const settled = await frozen()
		expect(settled.aztec - from).toBe(2)
		await Bun.sleep(TICK_MS * 3)
		expect(await frozen()).toEqual(settled)
	}

	test("a lone Inbox message becomes consumable through beats alone, then the beats stop", async () => {
		const before = await tips()
		const leaf = await sendMessage()
		expect(await within(TICK_MS * 4, () => consumableNow(leaf))).toBe(true)
		const blocksTaken = (await tips()).checkpointed - before.checkpointed
		console.log(`[stack] a lone L1→L2 message became consumable after ${blocksTaken} Aztec block(s)`)
		expect(blocksTaken).toBeGreaterThanOrEqual(1)
		expect(blocksTaken).toBeLessThanOrEqual(2)
		await expectOwedBeatsThenFrozen(before.checkpointed)
	})

	// Whether the racing block misses the message depends on the archiver's poll, so both outcomes must pass.
	test("a block that races the node's read of a message never strands it", async () => {
		const leaf = await sendMessage(() => nodeRpc<null>(stack.manifest.aztecNode, "aztecDebug_mineBlock"))
		const raced = await tips()
		const missed = !(await consumableAt(leaf, raced.checkpointed))
		expect(await within(TICK_MS * 4, () => consumableNow(leaf))).toBe(true)
		const beats = (await tips()).checkpointed - raced.checkpointed
		console.log(`[stack] the racing block ${missed ? "missed" : "carried"} the message; then ${beats} beat(s) to consumable`)
		expect(beats).toBeLessThanOrEqual(2)
		await expectOwedBeatsThenFrozen(raced.checkpointed)
	})

	test("a block the heartbeat did not mine gets finalized by one beat", async () => {
		await nodeRpc<null>(stack.manifest.aztecNode, "aztecDebug_mineBlock")
		const forced = await tips()
		expect(forced.finalized).toBeLessThan(forced.checkpointed)
		expect(await within(TICK_MS * 3, async () => (await tips()).finalized >= forced.checkpointed)).toBe(true)
		expect((await tips()).checkpointed - forced.checkpointed).toBe(1)
	})
})

// Registered only on request, so an ordinary run reports no skipped case.
if (process.env.PP_STACK_INTEGRATION && process.env.PP_STACK_LONG)
	describe("a stack left alone", () => {
		test("long idle: 1900 s at the real cadence moves neither chain, and the stack still answers", async () => {
			const stack = await startStack()
			try {
				const client = createPublicClient({ transport: http(stack.manifest.l1Rpc) })
				const read = async () => ({
					l1: await client.getBlockNumber({ cacheTime: 0 }),
					aztec: (await nodeRpc<{ checkpointed: { block: { number: number } } }>(stack.manifest.aztecNode, "node_getChainTips"))
						.checkpointed.block.number,
				})
				await Bun.sleep(150_000)
				const start = await read()
				const samples: { s: number; l1: string; aztec: number }[] = []
				for (let s = 60; s <= 1900; s += 60) {
					await Bun.sleep(60_000)
					const now = await read()
					samples.push({ s, l1: now.l1.toString(), aztec: now.aztec })
					expect(now).toEqual(start)
				}
				console.log(`[stack] long idle ${JSON.stringify(samples)}`)
				await (await fetch(stack.manifest.pool.aspApiUrl)).body?.cancel()
			} finally {
				await stack.stop()
			}
		})
	})
