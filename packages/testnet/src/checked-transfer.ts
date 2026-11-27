/**
 * A checked spend of the labelled token, made so that its freshness can be shown: the label's path
 * from the bot's snapshot of the record at the tip, a proof, then every check against the proof's own
 * anchor (canonical blocks, the record there, its pool root and time against Ethereum, the margin)
 * before the same proven bytes are sent. Nothing is sent when a check fails.
 */
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { ProvenTx, SendOutcome } from "@pp/bridge-core/account"
import {
	type AspSnapshot,
	type LabelPath,
	labelState,
	MAX_ROOT_AGE,
	type Origin,
	parseAspSnapshot,
	pathFor,
	type RootRecord,
	readRootRecord,
	SPEND_WINDOW,
} from "@pp/label-paths"
import {
	type Address,
	decodeFunctionResult,
	encodeFunctionData,
	type Hex,
	hexToBigInt,
	numberToHex,
	parseAbi,
	type PublicClient,
} from "viem"
import { CanaryError } from "./report"

/** A canonical L2 block: its height and hash. */
export type BlockRef = { block: number; blockHash: Hex }

/** The block a proof reads its private state at. */
export type Anchor = ProvenTx["anchor"]

/** The ASP registry's state at the record's L1 block, read by that block's hash. */
export type L1Root = { l1Block: bigint; l1BlockHash: Hex; latestRoot: bigint; timestamp: bigint }

/**
 * Seconds of slack a proof anchored at `anchorTime` keeps beyond the circuit's freshness bound
 * (`root_time + MAX_ROOT_AGE >= anchor + SPEND_WINDOW`); the circuit accepts zero, the canary does not.
 */
export const freshnessMargin = (rootTime: bigint, anchorTime: bigint): bigint => rootTime + MAX_ROOT_AGE - (anchorTime + SPEND_WINDOW)

export type SpendCheck =
	| "anchor-height"
	| "anchor-canonical"
	| "post-canonical"
	| "sequence"
	| "label"
	| "pool-root"
	| "root-time"
	| "margin"

/** What a checked spend observed after its proof. */
export type SpendFacts = {
	label: bigint
	origin: Origin
	minSequence: bigint
	/** The bot's first post since its restart, which every anchor must follow. */
	post: BlockRef
	anchor: Anchor
	/** The hashes the node holds now at the anchor's and the post's heights. */
	canonical: { anchor: Hex | undefined; post: Hex | undefined }
	/** The registry's record at the anchor. */
	record: RootRecord
	/** The snapshot the proof's path came from. */
	snapshot: AspSnapshot
	l1: L1Root
}

export type SpendVerdict = { failed: SpendCheck[]; margin: bigint; parity: { poolRoot: boolean; rootTime: boolean } }

const sameHash = (got: Hex | undefined, want: Hex) => got !== undefined && BigInt(got) === BigInt(want)

/**
 * Every check a proven spend must pass before it is sent. Heights and sequences alone can repeat after
 * a checkpoint rewind, so both blocks are matched by hash.
 */
export function assessSpend(f: SpendFacts): SpendVerdict {
	const margin = freshnessMargin(f.record.rootTime, f.anchor.timestamp)
	const parity = { poolRoot: f.l1.latestRoot === f.record.poolRoot, rootTime: f.l1.timestamp === f.record.rootTime }
	const checks: [SpendCheck, boolean][] = [
		["anchor-height", f.anchor.number >= f.post.block],
		["anchor-canonical", sameHash(f.canonical.anchor, f.anchor.hash)],
		["post-canonical", sameHash(f.canonical.post, f.post.blockHash)],
		["sequence", f.record.sequence >= f.minSequence],
		["label", labelState(f.record, f.snapshot, f.label, f.origin, f.anchor.timestamp) === "ACTIVE"],
		["pool-root", parity.poolRoot && f.l1.l1Block === f.record.l1Block],
		["root-time", parity.rootTime],
		["margin", margin > 0n],
	]
	return { failed: checks.filter(([, ok]) => !ok).map(([name]) => name), margin, parity }
}

/** The reads a checked spend makes. */
export type SpendIo = {
	tip(): Promise<{ number: number; hash: Hex; timestamp: bigint } | undefined>
	/** The node's hash at height `n` now, if it holds a block there. */
	blockHash(n: number): Promise<Hex | undefined>
	record(at: Hex): Promise<RootRecord>
	/** The bot's snapshot for `sequence`, or undefined when it holds none. */
	snapshot(sequence: bigint): Promise<AspSnapshot | undefined>
	l1Root(l1Block: bigint): Promise<L1Root>
}

const ASP_ABI = parseAbi(["function latestASPRoot() view returns (uint256)"])

/** The registry's latest root and the header time at `l1Block`, both from the header with one hash. */
export async function readL1Root(l1: Pick<PublicClient, "request">, aspRegistry: Address, l1Block: bigint): Promise<L1Root> {
	const header = await l1.request({ method: "eth_getBlockByNumber", params: [numberToHex(l1Block), false] })
	if (!header?.hash) throw new CanaryError("FAILED", "RPC_EVIDENCE_MISSING", `no L1 header at ${l1Block}`)
	const data = encodeFunctionData({ abi: ASP_ABI, functionName: "latestASPRoot" })
	const out = await l1.request({ method: "eth_call", params: [{ to: aspRegistry, data }, { blockHash: header.hash }] })
	const latestRoot = decodeFunctionResult({ abi: ASP_ABI, functionName: "latestASPRoot", data: out })
	return { l1Block, l1BlockHash: header.hash, latestRoot, timestamp: hexToBigInt(header.timestamp) }
}

type SpendNode = Pick<AztecNode, "getBlockNumber" | "getBlockData">

/** The live reads: the node, the registry's record by keyless JSON-RPC, the bot's snapshots and the L1 registry. */
export function liveSpendIo(a: {
	node: SpendNode
	l1: Pick<PublicClient, "request">
	aztecNode: string
	registry: Hex
	aspRegistry: Address
	botUrl: string
}): SpendIo {
	const blockData = (n: number) => a.node.getBlockData(BlockNumber(n))
	return {
		async tip() {
			const n = await a.node.getBlockNumber()
			const b = await blockData(n)
			return b && { number: Number(n), hash: b.blockHash.toString() as Hex, timestamp: b.header.globalVariables.timestamp }
		},
		blockHash: async (n) => (await blockData(n))?.blockHash.toString() as Hex | undefined,
		record: (at) => readRootRecord({ aztecNode: a.aztecNode, registry: a.registry, at }),
		async snapshot(sequence) {
			const res = await fetch(`${a.botUrl}/v1/snapshots/${sequence}`, { signal: AbortSignal.timeout(10_000) })
			if (res.status === 404) return undefined
			if (!res.ok) throw new CanaryError("FAILED", "BOT_SNAPSHOT", `HTTP ${res.status} for sequence ${sequence}`)
			return parseAspSnapshot(await res.json())
		},
		l1Root: (l1Block) => readL1Root(a.l1, a.aspRegistry, l1Block),
	}
}

export type ActivePath = { path: LabelPath; snapshot: AspSnapshot; record: RootRecord }

/**
 * The label's path from the bot's snapshot of the record at the tip, when the label is spendable there
 * with `budgetSec` to spare; undefined otherwise. Record and time come from one block, by hash.
 */
export async function activePath(io: SpendIo, label: bigint, origin: Origin, budgetSec: bigint): Promise<ActivePath | undefined> {
	const tip = await io.tip()
	if (!tip) return undefined
	const record = await io.record(tip.hash)
	const snapshot = await io.snapshot(record.sequence)
	if (!snapshot || labelState(record, snapshot, label, origin, tip.timestamp + budgetSec) !== "ACTIVE") return undefined
	const path = pathFor(snapshot, label, origin)
	return path ? { path, snapshot, record } : undefined
}

export type SpendRequest = { label: bigint; origin: Origin; minSequence: bigint; post: BlockRef; budgetSec: bigint }

export type CheckedSpend = { proven: ProvenTx; facts: SpendFacts; verdict: SpendVerdict; provingMs: number; outcome: SendOutcome }

/** The facts after the proof, read at its anchor. */
async function factsAt(io: SpendIo, r: SpendRequest, anchor: Anchor, snapshot: AspSnapshot): Promise<SpendFacts> {
	const [record, anchorHash, postHash] = await Promise.all([
		io.record(anchor.hash),
		io.blockHash(anchor.number),
		io.blockHash(r.post.block),
	])
	const l1 = await io.l1Root(record.l1Block)
	return { ...r, anchor, canonical: { anchor: anchorHash, post: postHash }, record, snapshot, l1 }
}

/**
 * Proves the spend `build` makes from the label's path, checks it at its anchor, and only then sends
 * the same proven transaction once.
 * @throws CanaryError `LABEL_NOT_ACTIVE` before proving; `SPEND_CHECK` naming every failed check, with
 * `onChecked` already called, when the proof may not be sent
 */
export async function checkedSpend(
	io: SpendIo,
	r: SpendRequest,
	act: {
		prove(path: LabelPath): Promise<ProvenTx>
		send(proven: ProvenTx): Promise<SendOutcome>
		onChecked(c: Omit<CheckedSpend, "outcome">): void
	},
): Promise<CheckedSpend> {
	const active = await activePath(io, r.label, r.origin, r.budgetSec)
	if (!active) throw new CanaryError("FAILED", "LABEL_NOT_ACTIVE", `label origin ${r.origin} is not spendable at the tip`)
	const t0 = performance.now()
	const proven = await act.prove(active.path)
	const provingMs = performance.now() - t0
	const facts = await factsAt(io, r, proven.anchor, active.snapshot)
	const verdict = assessSpend(facts)
	act.onChecked({ proven, facts, verdict, provingMs })
	if (verdict.failed.length)
		throw new CanaryError("FAILED", "SPEND_CHECK", `failed at anchor ${proven.anchor.number}: ${verdict.failed.join(", ")}`)
	return { proven, facts, verdict, provingMs, outcome: await act.send(proven) }
}
