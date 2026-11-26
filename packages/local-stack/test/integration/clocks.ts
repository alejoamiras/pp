import type { PublicClient } from "viem"
import { nodeRpc } from "../../src/node-rpc.ts"

/**
 * Reads the two clocks of one stack. `A` is the timestamp of the newest checkpointed Aztec block,
 * `E` the newest Ethereum block whose timestamp is at most `A` (what a bot may cite for that block).
 */

export type L1Block = { number: bigint; timestamp: bigint }
export type AztecBlock = { number: number; timestamp: bigint }

export async function checkpointed(nodeUrl: string): Promise<AztecBlock> {
	const tips = await nodeRpc<{ checkpointed: { block: { number: number } } }>(nodeUrl, "node_getChainTips")
	const number = tips.checkpointed.block.number
	const data = await nodeRpc<{ header: { globalVariables: { timestamp: string } } } | undefined>(nodeUrl, "node_getBlockData", [number])
	if (!data) throw new Error(`node has no data for its checkpointed block ${number}`)
	return { number, timestamp: BigInt(data.header.globalVariables.timestamp) }
}

/** Builds one empty Aztec block and returns once it is checkpointed on L1. */
export async function mineAztecBlock(nodeUrl: string, timeoutMs = 180_000): Promise<AztecBlock> {
	const before = await checkpointed(nodeUrl)
	await nodeRpc<null>(nodeUrl, "aztecDebug_mineBlock")
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const now = await checkpointed(nodeUrl)
		if (now.number > before.number) return now
		if (Date.now() > deadline) throw new Error(`block ${before.number + 1} not checkpointed within ${timeoutMs} ms`)
		await Bun.sleep(250)
	}
}

export async function l1Latest(client: PublicClient): Promise<L1Block> {
	const b = await client.getBlock({ blockTag: "latest" })
	return { number: b.number, timestamp: b.timestamp }
}

/** The newest Ethereum block with `timestamp <= ts`; the chain is short, so a walk back suffices. */
export async function newestAtOrBefore(client: PublicClient, ts: bigint, from?: L1Block): Promise<L1Block> {
	let b = from ?? (await l1Latest(client))
	while (b.timestamp > ts) {
		if (b.number === 0n) throw new Error(`no Ethereum block at or before ${ts}`)
		const prev = await client.getBlock({ blockNumber: b.number - 1n })
		b = { number: prev.number, timestamp: prev.timestamp }
	}
	return b
}

/** One snapshot taken just before a block is mined, completed by the block it produced. */
export type GapSample = {
	label: string
	aztecBlock: number
	A: string
	latest: { number: string; timestamp: string }
	E: { number: string; timestamp: string }
	/** latest − A: how far Ethereum runs ahead of the Aztec tip. */
	rawGap: number
	/** A − E: how stale the newest citable Ethereum block is against the Aztec tip. */
	snapshotGap: number
	/** next Aztec block − E: the age of a citation when the post lands. */
	inclusionGap: number
}

/** Snapshots `A`, `latest` and `E`, mines one block, and fills in the inclusion gap. */
export async function sampleThenMine(nodeUrl: string, client: PublicClient, label: string): Promise<GapSample> {
	const tip = await checkpointed(nodeUrl)
	const latest = await l1Latest(client)
	const e = await newestAtOrBefore(client, tip.timestamp, latest)
	const next = await mineAztecBlock(nodeUrl)
	return {
		label,
		aztecBlock: tip.number,
		A: tip.timestamp.toString(),
		latest: { number: latest.number.toString(), timestamp: latest.timestamp.toString() },
		E: { number: e.number.toString(), timestamp: e.timestamp.toString() },
		rawGap: Number(latest.timestamp - tip.timestamp),
		snapshotGap: Number(tip.timestamp - e.timestamp),
		inclusionGap: Number(next.timestamp - e.timestamp),
	}
}
