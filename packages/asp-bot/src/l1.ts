import type { L1Block } from "./decide"

export type L1Tag = "latest" | "safe" | "finalized"

export type BlockSource = { head(tag: L1Tag): Promise<L1Block>; at(number: bigint): Promise<L1Block> }

export const MAX_WALK_BACK = 256

/**
 * The newest Ethereum block at or below `tag` whose time is not after Aztec's block time `aztecTime`:
 * the registry refuses a `root_time` in its future. `null` when none lies within `MAX_WALK_BACK` blocks.
 */
export async function selectBlock(src: BlockSource, tag: L1Tag, aztecTime: bigint): Promise<L1Block | null> {
	let block = await src.head(tag)
	for (let steps = 0; block.timestamp > aztecTime; steps++) {
		if (steps === MAX_WALK_BACK || block.number === 0n) return null
		block = await src.at(block.number - 1n)
	}
	return block
}
