import type { Address, Hash, Hex, PublicClient } from "viem"
import { BaseError, ContractFunctionRevertedError, decodeEventLog, getAbiItem, isHex, RawContractError } from "viem"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import type { StaleRootCode } from "./errors"
import { bridgeMessageKey, type MessageEndpoints } from "./messages"
import type { BridgeReceipt } from "./types"

export type ResolverClient = Pick<
	PublicClient,
	"getBlockNumber" | "getLogs" | "readContract" | "getTransaction" | "getTransactionReceipt" | "call"
>

export type ResolverDeployment = MessageEndpoints & { asset: Address; poolVault: Address; deployBlock: bigint }

/** What the user asked for: the note, and the recipient and amount its message must pay. */
export type BridgeIntent = { nullifier: bigint; amount: bigint; secretHash: bigint }

export type Resolution =
	| { kind: "bridged"; receipt: BridgeReceipt }
	/** The nullifier was spent by another bridge intent or by a non-bridge pool transaction. */
	| { kind: "elsewhere" }
	/** One of our own transactions succeeded, yet no event names the nullifier. */
	| { kind: "inconsistent" }
	| { kind: "open" }

const BRIDGED = getAbiItem({ abi: PROCESSOR_PORTAL_ABI, name: "BridgedFromPool" })
const SPENT_NULLIFIERS_ABI = [
	{
		type: "function",
		name: "spentNullifiers",
		stateMutability: "view",
		inputs: [{ name: "nullifierHash", type: "uint256" }],
		outputs: [{ name: "spentAt", type: "uint256" }],
	},
] as const

/** Log queries stay within what public RPCs accept. */
const LOG_WINDOW = 10_000n

/** `query`'s unremoved logs from `from` to `head`, in fixed windows; stops at the first window holding any if `first`. */
export async function windowedLogs<L extends { removed: boolean }>(
	from: bigint,
	head: bigint,
	first: boolean,
	query: (fromBlock: bigint, toBlock: bigint) => Promise<L[]>,
): Promise<L[]> {
	const found: L[] = []
	for (let lo = from; lo <= head; lo += LOG_WINDOW) {
		const hi = lo + LOG_WINDOW - 1n < head ? lo + LOG_WINDOW - 1n : head
		found.push(...(await query(lo, hi)).filter((l) => !l.removed))
		if (first && found.length) break
	}
	return found
}

/** The portal's `BridgedFromPool` logs for any of `nullifiers` up to `head`; stops at the first if `first`. */
function bridgedLogs(c: ResolverClient, d: ResolverDeployment, nullifiers: readonly bigint[], head: bigint, first: boolean) {
	const args = { nullifier: [...nullifiers] }
	return windowedLogs(d.deployBlock, head, first, (fromBlock, toBlock) =>
		c.getLogs({ address: d.portal, event: BRIDGED, args, fromBlock, toBlock }),
	)
}

type BridgedLog = Awaited<ReturnType<typeof bridgedLogs>>[number]

function receiptOf(d: ResolverDeployment, log: BridgedLog) {
	const { args } = decodeEventLog({ abi: [BRIDGED], data: log.data, topics: log.topics })
	const receipt: BridgeReceipt = {
		l1TxHash: log.transactionHash as Hash,
		portal: d.portal,
		messageKey: args.messageKey,
		leafIndex: args.leafIndex,
		nullifier: args.nullifier,
		changeCommitment: args.changeCommitment,
		amount: args.amount,
		asset: d.asset,
	}
	return { args, receipt }
}

/** Every bridge of any of `nullifiers` from the portal, unverified: the caller checks each message against its intent. */
export async function bridgedReceipts(c: ResolverClient, d: ResolverDeployment, nullifiers: readonly bigint[]): Promise<BridgeReceipt[]> {
	if (nullifiers.length === 0) return []
	const head = await c.getBlockNumber({ cacheTime: 0 })
	return (await bridgedLogs(c, d, nullifiers, head, false)).map((l) => receiptOf(d, l).receipt)
}

/**
 * The one resolver every `submit` return path goes through. It searches the portal's
 * `BridgedFromPool` by the proof's nullifier from the generation's deploy block, so a copy that
 * landed before the user's own transaction is found, and verifies the event's message against the
 * intent: a different recipient or amount is another intent's bridge, never the user's receipt.
 * The log scan and the spent-nullifier read are pinned to one head block.
 *
 * @param ownSucceeded whether any of the user's own transactions for this nullifier succeeded
 * @param minHead a block the scan must reach, such as a receipt's: a node can lag the one that served it
 */
export async function resolveNullifier(
	c: ResolverClient,
	d: ResolverDeployment,
	intent: BridgeIntent,
	ownSucceeded: boolean,
	minHead = 0n,
): Promise<Resolution> {
	// viem caches the block number for a polling interval; a receipt just seen can be past that cache.
	const latest = await c.getBlockNumber({ cacheTime: 0 })
	const head = latest > minHead ? latest : minHead
	const [log] = await bridgedLogs(c, d, [intent.nullifier], head, true)
	if (log) {
		const { args, receipt } = receiptOf(d, log)
		const expected = await bridgeMessageKey(d, args, intent.secretHash)
		if (args.amount !== intent.amount || args.messageKey.toLowerCase() !== expected.toLowerCase()) return { kind: "elsewhere" }
		return { kind: "bridged", receipt }
	}
	// A landed bridge whose log the RPC lost also has a spent nullifier, so this check comes first.
	if (ownSucceeded) return { kind: "inconsistent" }
	const spentAt = await c.readContract({
		address: d.poolVault,
		abi: SPENT_NULLIFIERS_ABI,
		functionName: "spentNullifiers",
		args: [intent.nullifier],
		blockNumber: head,
	})
	return spentAt === 0n ? { kind: "open" } : { kind: "elsewhere" }
}

/**
 * The raw revert data anywhere in a viem error chain. A contract call carries it on a
 * `RawContractError`; a plain `call` leaves the node's bytes on the innermost error, as `data` or
 * `data.data`.
 */
export function revertData(e: unknown): Hex | undefined {
	if (!(e instanceof BaseError)) return undefined
	const raw = e.walk((x) => x instanceof RawContractError) as RawContractError | null
	if (raw && typeof raw.data === "string") return raw.data
	const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
	if (reverted?.raw) return reverted.raw
	const inner = (e.walk() as { data?: unknown } | null)?.data
	const data = typeof inner === "object" && inner !== null ? (inner as { data?: unknown }).data : inner
	return typeof data === "string" && isHex(data) ? data : undefined
}

/**
 * Why a reverted transaction reverted, by replaying it at its parent block. Best effort: another
 * transaction earlier in the same block can change the state the replay sees, so the cause is
 * `null` when the replay does not revert with a known stale root.
 */
export async function revertCause(
	c: ResolverClient,
	txHash: Hash,
	revertCode: (data: Hex) => StaleRootCode | null,
): Promise<StaleRootCode | null> {
	const [tx, receipt] = await Promise.all([c.getTransaction({ hash: txHash }), c.getTransactionReceipt({ hash: txHash })])
	if (!tx.to || receipt.blockNumber === 0n) return null
	try {
		await c.call({ account: tx.from, to: tx.to, data: tx.input, gas: tx.gas, blockNumber: receipt.blockNumber - 1n })
		return null
	} catch (e) {
		const data = revertData(e)
		return data ? revertCode(data) : null
	}
}
