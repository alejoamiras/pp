import { expect, test } from "bun:test"
import {
	type Address,
	createPublicClient,
	custom,
	type EncodeEventTopicsReturnType,
	encodeAbiParameters,
	encodeEventTopics,
	type Hex,
	padHex,
	type PublicClient,
	parseAbiItem,
	toHex,
	type WalletClient,
} from "viem"
import { createApprover } from "./approver.ts"
import type { Labels } from "./labels.ts"

const addr = (n: number): Address => padHex(toHex(n), { size: 20 })
const hash = (n: number): Hex => padHex(toHex(n), { size: 32 })
const [ENTRYPOINT, POOL, REGISTRY, ASSET] = [addr(1), addr(2), addr(3), addr(4)]
const ENTRYPOINT_DEPOSITED = parseAbiItem(
	"event Deposited(address indexed _asset, address indexed _depositor, uint256 _value, uint256 _fee)",
)
const VAULT_DEPOSITED = parseAbiItem(
	"event Deposited(uint256 outputCommitment, address indexed asset, uint256 depositedValue, address indexed caller)",
)
const LABEL_REGISTERED = parseAbiItem("event LabelRegistered(bytes _ciphertext)")
const uints = (...v: bigint[]) =>
	encodeAbiParameters(
		v.map(() => ({ type: "uint256" })),
		v,
	)

/** One deposit transaction by `depositor`, whose commitment the fake labels read as its label. */
function deposit(n: number, depositor: Address) {
	const tx = hash(n)
	// Every topic here is a single value: each event's indexed arguments are all given.
	const log = (address: Address, topics: EncodeEventTopicsReturnType, data: Hex) => ({
		address,
		topics: topics as Hex[],
		data,
		transactionHash: tx,
		blockNumber: "0x1",
	})
	const entry = log(
		ENTRYPOINT,
		encodeEventTopics({ abi: [ENTRYPOINT_DEPOSITED], args: { _asset: ASSET, _depositor: depositor } }),
		uints(1n, 0n),
	)
	const vault = log(POOL, encodeEventTopics({ abi: [VAULT_DEPOSITED], args: { asset: ASSET, caller: ENTRYPOINT } }), uints(BigInt(n), 1n))
	const label = log(REGISTRY, encodeEventTopics({ abi: [LABEL_REGISTERED] }), encodeAbiParameters([{ type: "bytes" }], ["0x01"]))
	return { tx, entry, logs: [entry, vault, label] }
}

/** A node that filters `eth_getLogs` by topic as a real one does: null or an empty list matches anything, a list any member. */
function fakeClient(deposits: ReturnType<typeof deposit>[]): PublicClient {
	const matches = (want: Hex | Hex[] | null | undefined, got: Hex | null | undefined) =>
		want == null ||
		(Array.isArray(want)
			? want.length === 0 || want.some((w) => w.toLowerCase() === got?.toLowerCase())
			: want.toLowerCase() === got?.toLowerCase())
	const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
		if (method === "eth_chainId") return "0xaa36a7"
		if (method === "eth_blockNumber") return "0x1"
		if (method === "eth_getLogs") {
			const topics = (params?.[0] as { topics?: (Hex | Hex[] | null)[] } | undefined)?.topics ?? []
			return deposits.map((d) => d.entry).filter((l) => topics.every((t, i) => matches(t, l.topics[i])))
		}
		if (method === "eth_getTransactionReceipt") {
			const d = deposits.find((x) => x.tx === (params?.[0] as Hex))
			return { transactionHash: params?.[0], status: "0x1", blockNumber: "0x1", logs: d?.logs ?? [] }
		}
		throw new Error(`unserved: ${method}`)
	}
	return createPublicClient({ transport: custom({ request }), pollingInterval: 10 }) as PublicClient
}

const labels: Labels = { publicKey: "0x", labelOf: (_c, commitment) => commitment, leafOf: (l) => l, rootOf: async (l) => BigInt(l.length) }
const wallet = { writeContract: async () => hash(99) } as unknown as WalletClient as never
const deployment = { aspRegistry: REGISTRY, pool: POOL, entrypoint: ENTRYPOINT, deployBlock: 1n }

test("approves the deposits of every listed owner and no other depositor's, and refuses an empty list", async () => {
	const [a, b, stranger] = [addr(10), addr(11), addr(12)]
	const client = fakeClient([deposit(1, a), deposit(2, stranger), deposit(3, b)])
	const approver = createApprover({ client, wallet, labels, owners: [a, b], deployment, log: () => {} })
	await approver.tick()
	expect(approver.approved()).toEqual([1n, 3n])
	expect(() => createApprover({ client, wallet, labels, owners: [] as never, deployment, log: () => {} })).toThrow("at least one owner")
})
