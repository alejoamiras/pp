import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bridgeDataV1, claimSecretHash, deriveClaimKey, deriveClaimSalt } from "@pp/bridge-spec"
import {
	type Address,
	encodeAbiParameters,
	encodeEventTopics,
	getAbiItem,
	type Hash,
	type Hex,
	hexToBigInt,
	keccak256,
	toHex,
	TransactionNotFoundError,
	TransactionReceiptNotFoundError,
	type WalletClient,
} from "viem"
import { vi } from "vitest"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import type { StackManifest } from "../stack-manifest"
import type { KeyValueStore } from "../client/journal"
import { bridgeMessageKey } from "../client/messages"
import { Preflights } from "../client/preflight"
import type { ResolverDeployment } from "../client/resolve"
import { type SessionPool, sessionFromPool } from "../client/session"
import type { SubmitContext, SubmitReader } from "../client/submit"
import { deploymentId, type PreparedBridgeSpend } from "../client/types"

export const OWNER: Address = "0x00000000000000000000000000000000000000Ff"
export const SENDER: Address = "0x00000000000000000000000000000000000000e5"
export const SIGNATURE: Hex = `0x${"11".repeat(32)}${"22".repeat(32)}1b`
export const PORTAL: Address = "0x00000000000000000000000000000000000000a1"
export const ASSET: Address = "0x00000000000000000000000000000000000000c3"
export const VAULT: Address = "0x00000000000000000000000000000000000000d4"
export const HUB: Hex = toHex(0x0b5n, { size: 32 })
export const SPENT_COMMITMENT = 123n
export const NULLIFIER = 456n
export const CLAIM_KEY = deriveClaimKey(SIGNATURE, OWNER)

export function manifest(hub: Hex = HUB): StackManifest {
	return {
		version: 1,
		chainId: 31337,
		l1Rpc: "http://127.0.0.1:8545",
		aztecNode: "http://127.0.0.1:8080",
		pool: {
			poolVault: VAULT,
			entrypoint: "0x00000000000000000000000000000000000000e1",
			aspRegistry: "0x00000000000000000000000000000000000000e2",
			keystore: "0x00000000000000000000000000000000000000e3",
			asset: ASSET,
			deployBlock: 1n,
			aspApiUrl: "http://127.0.0.1:3000",
		},
		bridge: {
			factory: "0x00000000000000000000000000000000000000f1",
			portal: PORTAL,
			hub,
			token: toHex(7n, { size: 32 }),
			registry: toHex(0n, { size: 32 }),
			deployBlock: 100n,
		},
	}
}

export const DEPLOYMENT: ResolverDeployment & { id: string } = {
	portal: PORTAL,
	chainId: 31337,
	hub: HUB,
	rollupVersion: 1n,
	asset: ASSET,
	poolVault: VAULT,
	deployBlock: 100n,
	id: deploymentId({ chainId: 31337, portal: PORTAL, hub: HUB }),
}

export function fakePool() {
	return {
		notes: vi.fn(async () => []),
		prepareSpend: vi.fn(async () => {
			throw new Error("unused")
		}),
		changeOpening: vi.fn(async () => {
			throw new Error("unused")
		}),
		nullifierOf: vi.fn(async () => NULLIFIER),
		assertRecoverable: vi.fn(async (_s: unknown) => {}),
		assertFresh: vi.fn(async (_s: unknown) => {}),
	} satisfies SessionPool
}

export const openSession = (pool: SessionPool = fakePool(), m: StackManifest = manifest()) => sessionFromPool(pool, m, OWNER, SIGNATURE)

/** A spend whose bridge-side fields are canonical for `recipient`; pool-side checks are the fake pool's. */
export async function bridgeSpend(recipient: AztecAddress, o: { amount?: bigint; salt?: bigint } = {}): Promise<PreparedBridgeSpend> {
	const amount = o.amount ?? 70n
	const claimSalt = o.salt ?? deriveClaimSalt(CLAIM_KEY, SPENT_COMMITMENT)
	const secretHash = toHex(await claimSecretHash(claimSalt, recipient), { size: 32 })
	const change = { commitment: 9n, precommitment: 8n, label: 5n, value: 30n }
	return {
		proof: {
			pA: [1n, 2n],
			pB: [
				[3n, 4n],
				[5n, 6n],
			],
			pC: [7n, 8n],
			pubSignals: [[NULLIFIER], [change.commitment], [10n], [11n], [12n], [amount], [hexToBigInt(ASSET)], [13n]],
		},
		noteData: [{ hint: toHex(1n, { size: 32 }), data: "0xab" }],
		processor: PORTAL,
		data: bridgeDataV1(secretHash),
		nullifier: NULLIFIER,
		spentCommitment: SPENT_COMMITMENT,
		change,
		amount,
		asset: ASSET,
		aspRoot: 12n,
		secretHash,
		claimSalt,
		recipient,
	}
}

export function memoryStore(failWrite: (n: number) => boolean = () => false) {
	const values = new Map<string, string>()
	let writes = 0
	const store: KeyValueStore = {
		getItem: (k) => values.get(k) ?? null,
		setItem: (k, v) => {
			if (failWrite(++writes)) throw new Error("quota")
			values.set(k, v)
		},
		removeItem: (k) => void values.delete(k),
	}
	return { store, values }
}

const BRIDGED = getAbiItem({ abi: PROCESSOR_PORTAL_ABI, name: "BridgedFromPool" })

type SentCall = {
	args: readonly [{ pubSignals: readonly (readonly bigint[])[] }, unknown, Hex]
	account: { address: Address }
	chain: unknown
	gas: bigint
}
type Log = { blockNumber: bigint; transactionHash: Hash; removed: false; nullifier: bigint; topics: Hex[]; data: Hex }

/** One L1 with the portal: what was sent, what landed, what is pending, and the logs the resolver reads. */
export class FakeChain {
	head = 200n
	spentAt = 0n
	readonly logs: Log[] = []
	readonly receipts = new Map<Hash, { status: "success" | "reverted"; blockNumber: bigint }>()
	readonly pending = new Set<Hash>()
	readonly simulate = vi.fn(async (_call: unknown) => ({}))
	/** What a send does once the wallet signed it; by default the bridge lands. */
	onSend: (call: SentCall, hash: Hash) => Promise<void> | void = (call, hash) => this.land(call.args[2], hash, call.args[0].pubSignals)

	async land(secretHash: Hex, hash: Hash, signals: readonly (readonly bigint[])[]): Promise<void> {
		const e = {
			nullifier: signals[0]?.[0] as bigint,
			changeCommitment: signals[1]?.[0] as bigint,
			amount: signals[5]?.[0] as bigint,
			leafIndex: 3n,
		}
		const messageKey = await bridgeMessageKey(DEPLOYMENT, e, hexToBigInt(secretHash))
		this.head += 1n
		this.logs.push({
			blockNumber: this.head,
			transactionHash: hash,
			removed: false,
			nullifier: e.nullifier,
			topics: encodeEventTopics({ abi: [BRIDGED], args: { messageKey, nullifier: e.nullifier } }) as Hex[],
			data: encodeAbiParameters(
				[{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
				[e.leafIndex, e.changeCommitment, e.amount],
			),
		})
		this.receipts.set(hash, { status: "success", blockNumber: this.head })
	}

	revert(hash: Hash): void {
		this.head += 1n
		this.receipts.set(hash, { status: "reverted", blockNumber: this.head })
	}

	readonly reader: SubmitReader = {
		getBlockNumber: async () => this.head,
		// viem ORs an array given for an indexed argument.
		getLogs: (async (q: { fromBlock: bigint; toBlock: bigint; args: { nullifier: bigint | bigint[] } }) =>
			this.logs.filter(
				(l) =>
					l.blockNumber >= q.fromBlock &&
					l.blockNumber <= q.toBlock &&
					([q.args.nullifier].flat() as bigint[]).includes(l.nullifier),
			)) as never,
		readContract: (async () => this.spentAt) as never,
		getTransaction: (async ({ hash }: { hash: Hash }) => {
			if (!this.pending.has(hash) && !this.receipts.has(hash)) throw new TransactionNotFoundError({ hash })
			return { from: SENDER, to: PORTAL, input: "0x", gas: 1n }
		}) as never,
		getTransactionReceipt: (async ({ hash }: { hash: Hash }) => {
			const r = this.receipts.get(hash)
			if (!r) throw new TransactionReceiptNotFoundError({ hash })
			return r
		}) as never,
		call: (async () => ({})) as never,
		simulateContract: ((call: unknown) => this.simulate(call)) as never,
		estimateContractGas: (async () => 100_000n) as never,
		waitForTransactionReceipt: (async ({ hash }: { hash: Hash }) => {
			const r = this.receipts.get(hash)
			if (!r) throw new Error("timed out")
			return r
		}) as never,
	}

	readonly writeContract = vi.fn(async (call: SentCall): Promise<Hash> => {
		const hash = keccak256(toHex(this.writeContract.mock.calls.length))
		this.pending.add(hash)
		await this.onSend(call, hash)
		return hash
	})

	wallet(address: Address = SENDER): WalletClient {
		return {
			account: { address, type: "json-rpc" },
			chain: { id: 31337 },
			getChainId: async () => 31337,
			writeContract: this.writeContract,
		} as unknown as WalletClient
	}
}

/** An Aztec wallet that lists `accounts`; mutate the array to drop one. */
export const aztecWallet = (accounts: AztecAddress[]) => ({ getAccounts: async () => accounts.map((item) => ({ alias: "", item })) })

export function context(chain: FakeChain, store: KeyValueStore, preflights = new Preflights()): SubmitContext {
	return {
		deployment: DEPLOYMENT,
		reader: chain.reader,
		store,
		preflights,
		reprove: vi.fn(async (_s, spend) => spend),
		receiptTimeoutMs: 1_000,
	}
}

export const randomRecipient = () => AztecAddress.random()

/** The smallest x that is no point's x coordinate on the curve: an address that fails `isValid()`. */
export async function offCurveAddress(): Promise<AztecAddress> {
	for (let x = 1n; ; x++) {
		const a = AztecAddress.fromBigIntUnsafe(x)
		if (!(await a.isValid())) return a
	}
}
