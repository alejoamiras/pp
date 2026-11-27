import {
	createPublicClient,
	custom,
	encodeAbiParameters,
	encodeEventTopics,
	getAbiItem,
	type Hash,
	type Hex,
	RawContractError,
	toHex,
} from "viem"
import { describe, expect, it, vi } from "vitest"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { bridgeMessageKey } from "./messages"
import { type ResolverClient, type ResolverDeployment, resolveNullifier, revertCause } from "./resolve"

const D: ResolverDeployment = {
	portal: "0x00000000000000000000000000000000000000a1",
	chainId: 31337,
	hub: toHex(0x0b5n, { size: 32 }),
	rollupVersion: 1n,
	asset: "0x00000000000000000000000000000000000000c3",
	poolVault: "0x00000000000000000000000000000000000000d4",
	deployBlock: 100n,
}
const INTENT = { nullifier: 11n, amount: 70n, secretHash: 99n }
const COPY = `0x${"c0".repeat(32)}` as Hash
const BRIDGED = getAbiItem({ abi: PROCESSOR_PORTAL_ABI, name: "BridgedFromPool" })

async function bridgedLog(block: bigint, secretHash: bigint, amount = INTENT.amount) {
	const e = { nullifier: INTENT.nullifier, changeCommitment: 22n, amount, leafIndex: 5n }
	const messageKey = await bridgeMessageKey(D, e, secretHash)
	return {
		blockNumber: block,
		transactionHash: COPY,
		removed: false,
		topics: encodeEventTopics({ abi: [BRIDGED], args: { messageKey, nullifier: e.nullifier } }),
		data: encodeAbiParameters(
			[{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
			[e.leafIndex, e.changeCommitment, e.amount],
		),
	}
}

function client(o: { head: bigint; log?: Awaited<ReturnType<typeof bridgedLog>>; spentAt?: bigint }) {
	const getLogs = vi.fn(async (q: { fromBlock: bigint; toBlock: bigint }) =>
		o.log && o.log.blockNumber >= q.fromBlock && o.log.blockNumber <= q.toBlock ? [o.log] : [],
	)
	const readContract = vi.fn(async (_q: { functionName: string; blockNumber: bigint }) => o.spentAt ?? 0n)
	return { c: { getBlockNumber: async () => o.head, getLogs, readContract } as unknown as ResolverClient, getLogs, readContract }
}

describe("resolveNullifier", () => {
	it("finds a copy that landed in an earlier block than the user's own transaction, across log windows", async () => {
		const { c, getLogs } = client({ head: 25_000n, log: await bridgedLog(12_000n, INTENT.secretHash) })
		const r = await resolveNullifier(c, D, INTENT, false)
		expect(r).toMatchObject({ kind: "bridged", receipt: { l1TxHash: COPY, leafIndex: 5n, amount: 70n, asset: D.asset } })
		expect(getLogs.mock.calls.map(([q]) => [q.fromBlock, q.toBlock])).toEqual([
			[100n, 10_099n],
			[10_100n, 20_099n],
		])
	})

	it("reports another intent's bridge of the same note as consumed elsewhere", async () => {
		expect(await resolveNullifier(client({ head: 200n, log: await bridgedLog(150n, 98n) }).c, D, INTENT, false)).toEqual({
			kind: "elsewhere",
		})
		const otherAmount = await bridgedLog(150n, INTENT.secretHash, 69n)
		expect(await resolveNullifier(client({ head: 200n, log: otherAmount }).c, D, INTENT, false)).toEqual({ kind: "elsewhere" })
	})

	it("checks a successful own transaction before the spent nullifier, both at one head", async () => {
		const spent = client({ head: 200n, spentAt: 7n })
		expect(await resolveNullifier(spent.c, D, INTENT, true)).toEqual({ kind: "inconsistent" })
		expect(await resolveNullifier(spent.c, D, INTENT, false)).toEqual({ kind: "elsewhere" })
		expect(spent.readContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "spentNullifiers", blockNumber: 200n })
		expect(await resolveNullifier(client({ head: 200n }).c, D, INTENT, false)).toEqual({ kind: "open" })
	})
})

describe("revertCause", () => {
	const tx = { from: "0x00000000000000000000000000000000000000e5", to: D.portal, input: "0x1234" as Hex, gas: 1n }
	const replay = (call: () => Promise<unknown>) =>
		({
			getTransaction: async () => tx,
			getTransactionReceipt: async () => ({ blockNumber: 151n }),
			call: vi.fn(call),
		}) as unknown as ResolverClient

	it("names a stale root from the parent-block replay, and is null when the replay cannot tell", async () => {
		const stale = replay(async () => {
			throw new RawContractError({ data: "0xdeadbeef" })
		})
		expect(await revertCause(stale, COPY, (d) => (d === "0xdeadbeef" ? "ASP_ROOT_STALE" : null))).toBe("ASP_ROOT_STALE")
		expect(
			await revertCause(
				replay(async () => ({})),
				COPY,
				() => "ASP_ROOT_STALE",
			),
		).toBeNull()
		expect(await revertCause(stale, COPY, () => null)).toBeNull()
	})

	it("reads the revert bytes a real viem call carries on its innermost error", async () => {
		const node = createPublicClient({
			transport: custom({
				async request({ method }) {
					if (method === "eth_call") throw Object.assign(new Error("execution reverted"), { code: 3, data: "0xbc158616" })
					throw new Error(`unexpected ${method}`)
				},
			}),
		})
		const real = replay(() => node.call({ to: D.portal, data: "0x1234", blockNumber: 150n }))
		expect(await revertCause(real, COPY, (d) => (d === "0xbc158616" ? "ASP_ROOT_STALE" : null))).toBe("ASP_ROOT_STALE")
	})
})
