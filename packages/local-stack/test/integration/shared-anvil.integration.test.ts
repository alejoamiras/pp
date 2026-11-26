import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { anvilKey, type PoolUser, type PreparedSpend, STUB_PROCESSOR_ABI, USER_INDEX } from "@pp/pp-env"
import { type Address, createPublicClient, createWalletClient, erc20Abi, type Hex, http, type PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { nodeInfo } from "../../src/node-rpc.ts"
import { type Stack, startStack } from "../../src/stack.ts"
import { type AztecBlock, checkpointed, type GapSample, l1Latest, mineAztecBlock, sampleThenMine } from "./clocks.ts"

// Anvil accounts: the node publishes from 0, bridge actors start at 1, pp-env holds 13 and 14.
const SECOND_USER_INDEX = 12
const SUBMITTER_INDEX = 11
const PINGER_INDEX = 10
const PING_TO = privateKeyToAccount(anvilKey(9)).address
const DATA = "0xc0ffee" as Hex
const LIVENESS = 1200n
const SLOT = 72n
const MAX_EXPIRY_BLOCKS = 25

const KEYSTORE_ABI = [
	{ type: "function", name: "currentRoot", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
	{ type: "function", name: "keystoreRootLiveness", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
	{
		type: "function",
		name: "previousRoots",
		stateMutability: "view",
		inputs: [{ name: "_root", type: "uint256" }],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "isKnownRoot",
		stateMutability: "view",
		inputs: [{ name: "_root", type: "uint256" }],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "event",
		name: "RootSuperseded",
		inputs: [
			{ name: "_oldRoot", type: "uint256", indexed: true },
			{ name: "_newRoot", type: "uint256", indexed: true },
			{ name: "_oldRootValidUntil", type: "uint256", indexed: false },
		],
	},
] as const
const ASP_ABI = [
	{ type: "function", name: "latestASPRoot", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const
const SPEND_ABI = [...STUB_PROCESSOR_ABI, { type: "error", name: "PoolVault_UnknownKeystoreRoot", inputs: [] }] as const

const keystoreRootOf = (s: PreparedSpend) => s.args[0].pubSignals[3]?.[0]
const aspRootOf = (s: PreparedSpend) => s.args[0].pubSignals[4]?.[0]

const wallet = (rpcUrl: string, index: number) =>
	createWalletClient({
		chain: { ...foundry, rpcUrls: { default: { http: [rpcUrl] } } },
		transport: http(rpcUrl),
		account: privateKeyToAccount(anvilKey(index)),
	})

describe.skipIf(!process.env.PP_STACK_INTEGRATION)("the pool on the anvil the Aztec network drives", () => {
	let stack: Stack
	let client: PublicClient
	let user: PoolUser
	let stub: Address
	let label: bigint
	let p0: PreparedSpend
	let p1: PreparedSpend
	let p1Root: bigint
	let p1Expiry: bigint
	let p0ProvedAt: bigint
	let p0Age = 0n
	const gaps: GapSample[] = []
	const steps: number[] = []
	let expiryBlocks = 0
	const seconds: Record<string, number> = {}

	const timed = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
		const t0 = performance.now()
		const out = await fn()
		seconds[key] = Math.round((performance.now() - t0) / 100) / 10
		return out
	}
	const keystore = () => stack.pool.deployment.keystore
	const currentRoot = () => client.readContract({ address: keystore(), abi: KEYSTORE_ABI, functionName: "currentRoot" })
	const validUntil = (root: bigint) =>
		client.readContract({ address: keystore(), abi: KEYSTORE_ABI, functionName: "previousRoots", args: [root] })
	const knownAt = (root: bigint, blockNumber: bigint) =>
		client.readContract({ address: keystore(), abi: KEYSTORE_ABI, functionName: "isKnownRoot", args: [root], blockNumber })
	const stubState = async () => ({
		balance: await client.readContract({ address: stack.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [stub] }),
		spends: await client.readContract({ address: stub, abi: STUB_PROCESSOR_ABI, functionName: "spendCount" }),
	})
	const ping = async () => {
		const w = wallet(stack.l1Rpc, PINGER_INDEX)
		const hash = await w.sendTransaction({ to: PING_TO, value: 1n })
		expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success")
	}
	const spend = (amountOut: bigint) => user.prepareSpend({ processor: stub, data: DATA, asset: stack.pool.asset, amountOut })

	beforeAll(async () => {
		stack = await timed("boot", () => startStack({ onStep: (s) => console.log(`[stack] ${s.step} up in ${s.seconds.toFixed(1)} s`) }))
		client = createPublicClient({ transport: http(stack.l1Rpc), pollingInterval: 100 })
	})

	afterAll(async () => {
		console.log(
			`[stack] clock ${JSON.stringify({ runId: stack?.runId, gaps, aztecSteps: steps, expiryBlocks, p0AgeAtLanding: Number(p0Age), seconds })}`,
		)
		await stack?.stop()
	})

	test("a. ten Aztec blocks checkpoint on the shared anvil", async () => {
		const [aztec0, l10] = [await checkpointed(stack.aztecNode), await l1Latest(client)]
		for (let i = 0; i < 10; i++) await mineAztecBlock(stack.aztecNode)
		const [aztec1, l11] = [await checkpointed(stack.aztecNode), await l1Latest(client)]
		expect(aztec1.number - aztec0.number).toBe(10)
		expect(l11.number - l10.number).toBeGreaterThanOrEqual(10n)
		const { l1ContractAddresses } = await nodeInfo(stack.aztecNode)
		expect(await client.getCode({ address: l1ContractAddresses.rollupAddress })).toBeTruthy()
	})

	test("b. user 13 registers, deposits 100, and the ASP approves the label", async () => {
		user = await stack.pool.createUser({ accountIndex: USER_INDEX })
		await stack.pool.mint(user.address, 1_000n)
		await user.registerKeystore()
		const deposit = await timed("deposit", () => user.deposit({ asset: stack.pool.asset, value: 100n }))
		label = deposit.label
		await stack.pool.asp.approveLabel(label)
		await user.sync()
		expect(user.notes().find((n) => n.commitment === deposit.commitment)).toMatchObject({ value: 100n, label, status: "ACTIVE" })
		expect(await client.readContract({ address: keystore(), abi: KEYSTORE_ABI, functionName: "keystoreRootLiveness" })).toBe(LIVENESS)
	})

	test("c. P0 is proved against the current keystore root and the latest ASP root", async () => {
		stub = await stack.pool.deployStub()
		p0 = await timed("proveP0", () => spend(40n))
		p0ProvedAt = (await l1Latest(client)).timestamp
		const current = await currentRoot()
		expect(current).not.toBe(0n)
		expect(keystoreRootOf(p0)).toBe(current)
		const aspRoot = await client.readContract({
			address: stack.pool.deployment.aspRegistry,
			abi: ASP_ABI,
			functionName: "latestASPRoot",
		})
		expect(aspRootOf(p0)).toBe(aspRoot)
	})

	test("d. eighteen blocks back to back step 72 s each and reach the liveness window", async () => {
		let prev: AztecBlock = await checkpointed(stack.aztecNode)
		for (let i = 0; i < 18; i++) {
			const next = await mineAztecBlock(stack.aztecNode)
			steps.push(Number(next.timestamp - prev.timestamp))
			prev = next
		}
		expect(steps).toEqual(Array(18).fill(Number(SLOT)))
		expect((await l1Latest(client)).timestamp - p0ProvedAt).toBeGreaterThanOrEqual(LIVENESS)
	})

	test("e. P0, held past the window against a root nobody superseded, still lands", async () => {
		const hash = await stack.pool.submitViaStub(stub, p0, SUBMITTER_INDEX)
		const landed = await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber })
		p0Age = landed.timestamp - p0ProvedAt
		expect(p0Age).toBeGreaterThan(LIVENESS)
		const [asset, amount, nullifier, changeCommitment] = await client.readContract({
			address: stub,
			abi: STUB_PROCESSOR_ABI,
			functionName: "lastSpend",
		})
		expect({ asset, amount, nullifier, changeCommitment }).toEqual({
			asset: stack.pool.asset,
			amount: 40n,
			nullifier: p0.nullifier,
			changeCommitment: p0.changeCommitment,
		})
		await user.sync()
		expect(user.notes().find((n) => n.commitment === p0.changeCommitment)).toMatchObject({ value: 60n, label, status: "ACTIVE" })
	})

	test("f. the three gaps, with Ethereum traffic and while idle", async () => {
		for (let i = 1; i <= 5; i++) {
			await ping()
			gaps.push(await sampleThenMine(stack.aztecNode, client, `transfer-${i}`))
		}
		await Bun.sleep(90_000)
		gaps.push(await sampleThenMine(stack.aztecNode, client, "idle-90"))
		await Bun.sleep(90_000)
		await ping()
		gaps.push(await sampleThenMine(stack.aztecNode, client, "idle-90-then-transfer"))
		console.log(`[stack] gaps ${JSON.stringify(gaps)}`)
		expect(gaps).toHaveLength(7)
	})

	test("g. a second registration supersedes P1's root and stamps its expiry", async () => {
		p1 = await timed("proveP1", () => spend(10n))
		p1Root = keystoreRootOf(p1) ?? 0n
		expect(p1Root).toBe(await currentRoot())
		const second = await stack.pool.createUser({ accountIndex: SECOND_USER_INDEX })
		await second.registerKeystore()
		const logs = await client.getContractEvents({
			address: keystore(),
			abi: KEYSTORE_ABI,
			eventName: "RootSuperseded",
			args: { _oldRoot: p1Root },
			fromBlock: stack.pool.deployment.deployBlock,
		})
		expect(logs).toHaveLength(1)
		const [log] = logs
		const block = await client.getBlock({ blockNumber: log?.blockNumber ?? 0n })
		p1Expiry = await validUntil(p1Root)
		expect(await currentRoot()).not.toBe(p1Root)
		expect(p1Expiry).toBe(block.timestamp + LIVENESS)
		expect(log?.args._oldRootValidUntil).toBe(p1Expiry)
	})

	test("h. the superseded root stops being known exactly at its expiry", async () => {
		while ((await l1Latest(client)).timestamp < p1Expiry) {
			if (++expiryBlocks > MAX_EXPIRY_BLOCKS) throw new Error(`still before ${p1Expiry} after ${MAX_EXPIRY_BLOCKS} blocks`)
			await mineAztecBlock(stack.aztecNode)
		}
		let after = await l1Latest(client)
		for (;;) {
			const prev = await client.getBlock({ blockNumber: after.number - 1n })
			if (prev.timestamp < p1Expiry) break
			after = { number: prev.number, timestamp: prev.timestamp }
		}
		console.log(
			`[stack] expiry ${p1Expiry} crossed between blocks ${after.number - 1n} and ${after.number} after ${expiryBlocks} Aztec blocks`,
		)
		expect(await knownAt(p1Root, after.number - 1n)).toBe(true)
		expect(await knownAt(p1Root, after.number)).toBe(false)
	})

	test("i. P1 is refused once its root expired, and nothing moves", async () => {
		const before = await stubState()
		const submit = wallet(stack.l1Rpc, SUBMITTER_INDEX).writeContract({
			address: stub,
			abi: SPEND_ABI,
			functionName: "spend",
			args: p1.args,
		})
		await expect(submit).rejects.toThrow("PoolVault_UnknownKeystoreRoot")
		expect(await stubState()).toEqual(before)
	})

	test("j. the same spend, proved again, lands", async () => {
		const before = await stubState()
		const again = await spend(10n)
		expect(keystoreRootOf(again)).toBe(await currentRoot())
		await stack.pool.submitViaStub(stub, again, SUBMITTER_INDEX)
		expect(await stubState()).toEqual({ balance: before.balance + 10n, spends: before.spends + 1n })
	})
})
