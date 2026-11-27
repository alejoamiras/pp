import { OutboxAbi } from "@aztec-foundation/l1-artifacts/OutboxAbi"
import { type EventCursor, getPublicEvents } from "@aztec-labs/aztec.js/events"
import { BlockNumber, type EpochNumber } from "@aztec-labs/foundation/branded-types"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { type AbiType, decodeFunctionSignature, type EventMetadataDefinition, EventSelector } from "@aztec-labs/stdlib/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { computeL2ToL1MembershipWitness, getL2ToL1MessageLeafId, type OutboxRootsReader } from "@aztec-labs/stdlib/messaging"
import { type ExecutionPayload, TxHash, TxStatus } from "@aztec-labs/stdlib/tx"
import { exitContentV1, ragequitContentV1 } from "@pp/bridge-spec"
import {
	type Account,
	type Address,
	bytesToHex,
	getAbiItem,
	getAddress,
	type Hash,
	type Hex,
	isAddressEqual,
	type PublicClient,
	type WalletClient,
} from "viem"
import { tokenBridgeHubArtifact } from "../artifacts"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { guarded } from "./boundary"
import type { ClientDeployment } from "./deployment"
import { BridgeClientError } from "./errors"
import { allPages, type ExitReads, type ExitWitness, messageIndices, settleWith } from "./exits"
import { callPayload, sponsored } from "./payload"
import { windowedLogs } from "./resolve"
import type { ExitTicket } from "./types"

const EXIT_SETTLED = getAbiItem({ abi: PROCESSOR_PORTAL_ABI, name: "ExitSettled" })

/** What a ticket says, without where it was found. */
export type TicketBody = ExitTicket extends infer T ? (T extends ExitTicket ? Omit<T, "l2TxHash" | "messageIndexInTx"> : never) : never

/** A ready ticket's Outbox witness: its identity and the rest of what a settle call takes. */
export type ExitProof = ExitWitness & { numCheckpointsInEpoch: bigint; leafIndex: bigint; path: Hex[] }

export type ExitNode = Pick<AztecNode, "getPublicLogsByTags" | "getTxReceipt" | "getL2ToL1Messages" | "getBlock" | "getCheckpointsData">

export type ExitReader = Pick<
	PublicClient,
	"readContract" | "getLogs" | "getBlockNumber" | "simulateContract" | "waitForTransactionReceipt"
>

export type ExitContext = { deployment: ClientDeployment; reader: ExitReader; node: ExitNode; receiptTimeoutMs: number }

const TICKET_EVENTS = { ragequit: "RagequitTicket", public: "PublicExitTicket" } as const

type TicketKind = keyof typeof TICKET_EVENTS

let metadata: Promise<Record<TicketKind, EventMetadataDefinition>> | undefined

/** Each ticket event's selector and field layout, as the committed hub artifact declares them. */
export function ticketEvents(): Promise<Record<TicketKind, EventMetadataDefinition>> {
	metadata ??= (async () => {
		const events = (tokenBridgeHubArtifact.outputs.structs.events ?? []) as Extract<AbiType, { kind: "struct" }>[]
		const of = async (name: string): Promise<EventMetadataDefinition> => {
			const abiType = events.find((e) => e.path.endsWith(`::${name}`))
			if (!abiType) throw new BridgeClientError("DEPLOYMENT_MISMATCH", { source: "TicketEventMissing" })
			// The signature reads only each field's name and type; visibility is a function parameter's.
			const fields = abiType.fields as Parameters<typeof decodeFunctionSignature>[1]
			return {
				eventSelector: await EventSelector.fromSignature(decodeFunctionSignature(name, fields)),
				abiType,
				fieldNames: abiType.fields.map((f) => f.name),
			}
		}
		return { ragequit: await of(TICKET_EVENTS.ragequit), public: await of(TICKET_EVENTS.public) }
	})()
	return metadata
}

/** The Outbox message a ticket's exit sent: the hub to the portal, carrying the v1 exit content. */
export function exitMessageHash(d: Pick<ClientDeployment, "hub" | "portal" | "chainId" | "rollupVersion">, t: TicketBody): Fr {
	const content = t.kind === "ragequit" ? ragequitContentV1(t) : exitContentV1(t)
	return computeL2ToL1MessageHash({
		l2Sender: AztecAddress.fromStringUnsafe(d.hub),
		l1Recipient: EthAddress.fromString(d.portal),
		content: new Fr(content),
		rollupVersion: new Fr(d.rollupVersion),
		chainId: new Fr(d.chainId),
	})
}

/**
 * Refuses an exit payee before anything is built: a mixed-case address whose checksum fails, by
 * the predicate of the parser that encodes it (which accepts all-lowercase and all-uppercase hex),
 * and the portal, which the hub refuses because the portal never pays itself.
 * @throws BridgeClientError `SPEND_MISMATCH` with source `PayeeChecksum` or `PayeeIsPortal`
 */
export function assertExitPayee(portal: Address, payee: Address): void {
	if (!EthAddress.isAddress(payee)) throw new BridgeClientError("SPEND_MISMATCH", { source: "PayeeChecksum" })
	if (isAddressEqual(payee, portal)) throw new BridgeClientError("SPEND_MISMATCH", { source: "PayeeIsPortal" })
}

/**
 * The hub's `ragequit` of `amount` under `label` to `payee`, paid by the SponsoredFPC, for the
 * holder's wallet to send. The burn takes the label's largest notes first; see `ragequitChunks`.
 * @throws BridgeClientError `SPEND_MISMATCH` naming the refused field in `source`: a payee that is
 * zero, wider than 160 bits, mixed-case with a failing checksum, or the portal (which the hub
 * refuses), an amount of zero or of 2^128 or more, a label of zero or of the field modulus or more
 */
export function ragequitPayload(d: ClientDeployment, a: { payee: Address; amount: bigint; label: bigint }): Promise<ExecutionPayload> {
	return guarded(async () => {
		ragequitContentV1(a)
		assertExitPayee(d.portal, a.payee)
		const args = [AztecAddress.fromStringUnsafe(d.token), EthAddress.fromString(a.payee), a.amount, new Fr(a.label)]
		return sponsored(await callPayload(tokenBridgeHubArtifact, AztecAddress.fromStringUnsafe(d.hub), "ragequit", args))
	})
}

const integer = (v: unknown): bigint => BigInt(String(v))

function bodyOf(kind: TicketKind, e: Record<string, unknown>): TicketBody {
	const common = { token: String(e.token), payee: getAddress(String(e.payee)), amount: integer(e.amount) }
	return kind === "ragequit" ? { kind, ...common, label: integer(e.label) } : { kind, ...common }
}

type Found = { body: TicketBody; tx: string; block: number }

async function found(c: ExitContext, kind: TicketKind, fromBlock: BlockNumber | undefined): Promise<Found[]> {
	const def = (await ticketEvents())[kind]
	const contractAddress = AztecAddress.fromStringUnsafe(c.deployment.hub)
	// getPublicEvents reads only getPublicLogsByTags from the node.
	const node = c.node as AztecNode
	const events = await allPages(async (afterEvent: EventCursor | undefined) => {
		const page = await getPublicEvents<Record<string, unknown>>(node, def, { contractAddress, fromBlock, afterEvent })
		return { items: page.events, next: page.nextCursor }
	})
	return events.map((e) => ({ body: bodyOf(kind, e.event), tx: e.metadata.txHash.toString(), block: Number(e.metadata.l2BlockNumber) }))
}

/** Each ticket of one transaction with its message index, matched against the transaction's own messages. */
async function indexed(c: ExitContext, tx: string, group: Found[]): Promise<ExitTicket[]> {
	const receipt = await c.node.getTxReceipt(TxHash.fromString(tx), { includeTxEffect: true })
	if (!receipt.txEffect) throw new BridgeClientError("RPC_INCONSISTENT")
	const messages = receipt.txEffect.l2ToL1Msgs.map((m) => m.toString() as Hex)
	const indices = messageIndices(
		group.map((f) => exitMessageHash(c.deployment, f.body).toString() as Hex),
		messages,
	)
	return group.map((f, i) => ({ ...f.body, l2TxHash: tx as Hex, messageIndexInTx: indices[i] as number }))
}

/**
 * The hub's exit tickets for the deployment's token, from L2 block `fromBlock` (default: the first)
 * on, optionally only those paying `payee`: chain data alone. One ticket per message, so identical
 * exits in one transaction stay distinct.
 * @throws BridgeClientError `RPC_INCONSISTENT` when a ticket's transaction does not carry its message
 */
export async function exitTickets(c: ExitContext, a: { payee?: Address; fromBlock?: bigint }): Promise<ExitTicket[]> {
	const from = a.fromBlock === undefined ? undefined : BlockNumber(Number(a.fromBlock))
	const all = (await Promise.all([found(c, "ragequit", from), found(c, "public", from)])).flat()
	const token = AztecAddress.fromStringUnsafe(c.deployment.token)
	const mine = all
		.filter((f) => AztecAddress.fromStringUnsafe(f.body.token).equals(token) && (!a.payee || isAddressEqual(f.body.payee, a.payee)))
		.sort((x, y) => x.block - y.block)
	const byTx = new Map<string, Found[]>()
	for (const f of mine) byTx.set(f.tx, [...(byTx.get(f.tx) ?? []), f])
	const out: ExitTicket[] = []
	for (const [tx, group] of byTx) out.push(...(await indexed(c, tx, group)))
	return out
}

/** The Outbox's roots for an epoch, read through the client's own L1 reader. */
const rootsOf = (c: ExitContext): OutboxRootsReader => ({
	getRoots: async (epoch: EpochNumber) => {
		const roots = await c.reader.readContract({
			address: c.deployment.outbox,
			abi: OutboxAbi,
			functionName: "getRoots",
			args: [BigInt(epoch)],
		})
		return roots.map((r) => Fr.fromString(r))
	},
})

/**
 * The ticket's witness once the Outbox holds a root covering it. A ticket whose transaction the node
 * dropped, or whose message index names another message, is not this deployment's exit.
 */
async function proofOf(c: ExitContext, t: ExitTicket): Promise<ExitProof | undefined> {
	const receipt = await c.node.getTxReceipt(TxHash.fromString(t.l2TxHash), { includeTxEffect: true })
	if (receipt.status === TxStatus.DROPPED) throw new BridgeClientError("TICKET_NOT_FOUND")
	if (!receipt.txEffect) return undefined
	const hash = exitMessageHash(c.deployment, t)
	if (!receipt.txEffect.l2ToL1Msgs[t.messageIndexInTx]?.equals(hash)) throw new BridgeClientError("TICKET_NOT_FOUND")
	const w = await computeL2ToL1MembershipWitness(c.node, rootsOf(c), hash, receipt, t.messageIndexInTx)
	if (!w) return undefined
	return {
		epoch: BigInt(w.epochNumber),
		leafId: getL2ToL1MessageLeafId(w),
		numCheckpointsInEpoch: BigInt(w.numCheckpointsInEpoch),
		leafIndex: w.leafIndex,
		path: w.siblingPath.toBufferArray().map((b) => bytesToHex(b)),
	}
}

/** The chain reads `exitState` and `settleWith` run on, keyed by the witness's `(epoch, leafId)`. */
export function exitReads(c: ExitContext): ExitReads<ExitProof> {
	const d = c.deployment
	return {
		witness: (t) => proofOf(c, t),
		settledTx: async (w) => {
			// Uncached: a settle mined within viem's cache window must be inside the scan.
			const head = await c.reader.getBlockNumber({ cacheTime: 0 })
			const logs = await windowedLogs(d.deployBlock, head, true, async (fromBlock, toBlock) => {
				const window = await c.reader.getLogs({
					address: d.portal,
					event: EXIT_SETTLED,
					args: { epoch: w.epoch },
					fromBlock,
					toBlock,
				})
				return window.filter((l) => l.args.leafId === w.leafId)
			})
			return logs[0]?.transactionHash ?? null
		},
		consumed: (w) =>
			c.reader.readContract({
				address: d.outbox,
				abi: OutboxAbi,
				functionName: "hasMessageBeenConsumedAtEpoch",
				args: [w.epoch, w.leafId],
			}),
	}
}

async function sendSettle(c: ExitContext, l1: WalletClient, account: Account, t: ExitTicket, w: ExitProof): Promise<Hash> {
	const base = { address: c.deployment.portal, abi: PROCESSOR_PORTAL_ABI, account } as const
	const proof = [w.epoch, w.numCheckpointsInEpoch, w.leafIndex, w.path] as const
	const chain = l1.chain ?? null
	if (t.kind === "ragequit") {
		const call = { ...base, functionName: "settleRagequit", args: [t.payee, t.amount, t.label, ...proof] } as const
		await c.reader.simulateContract(call)
		return l1.writeContract({ ...call, chain })
	}
	const call = { ...base, functionName: "settlePublicExit", args: [t.payee, t.amount, ...proof] } as const
	await c.reader.simulateContract(call)
	return l1.writeContract({ ...call, chain })
}

/**
 * Settles a ready ticket from `l1`, or returns the transaction that already settled it. The result is
 * always the transaction of the portal's `ExitSettled` for the ticket's exact `(epoch, leafId)`.
 * @throws BridgeClientError `CHAIN_MISMATCH`; `EXIT_NOT_READY` while no Outbox root covers it;
 * `TICKET_NOT_FOUND`; `UNCERTAIN` with `l1TxHash` when the send has no receipt in time or the event
 * read after it fails; `REVERTED`
 */
export async function settle(c: ExitContext, t: ExitTicket, l1: WalletClient): Promise<Hash> {
	const { account, chain } = l1
	if (!account) throw new BridgeClientError("RPC_FAILED", { source: "AccountNotFoundError" })
	if ((await l1.getChainId()) !== c.deployment.chainId || (chain && chain.id !== c.deployment.chainId))
		throw new BridgeClientError("CHAIN_MISMATCH")
	const io = exitReads(c)
	return settleWith(io, t, async (w) => {
		const hash = await sendSettle(c, l1, account, t, w)
		const receipt = await c.reader.waitForTransactionReceipt({ hash, timeout: c.receiptTimeoutMs }).catch(() => null)
		// A failed read after the broadcast must not lose its hash; the caller re-reads the ticket later.
		const settled = await io.settledTx(w).catch(() => undefined)
		if (settled) return settled
		if (!receipt || settled === undefined) throw new BridgeClientError("UNCERTAIN", { l1TxHash: hash })
		throw new BridgeClientError(receipt.status === "success" ? "RPC_INCONSISTENT" : "REVERTED", { l1TxHash: hash })
	})
}
