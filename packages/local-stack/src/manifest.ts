import type { StackManifest } from "@pp/bridge-core"
import type { Address } from "viem"

/** What a booted stack knows about itself; plain data, so this module never loads either harness. */
export type ManifestInputs = {
	chainId: number
	l1Rpc: string
	aztecNode: string
	pool: { poolVault: Address; entrypoint: Address; aspRegistry: Address; keystore: Address; deployBlock: bigint }
	asset: Address
	aspUrl: string
	/** Present once the bridge step opened entries. */
	bridge?: StackManifest["bridge"]
	/** Present once the bot's first post landed. */
	bot?: StackManifest["bot"]
}

/** A local stack's manifest; `serializeStackManifest` validates it. */
export function buildManifest(i: ManifestInputs): StackManifest {
	return {
		version: 1,
		chainId: i.chainId,
		l1Rpc: i.l1Rpc,
		aztecNode: i.aztecNode,
		pool: { ...i.pool, asset: i.asset, aspApiUrl: i.aspUrl },
		...(i.bridge ? { bridge: i.bridge } : {}),
		...(i.bot ? { bot: i.bot } : {}),
	}
}
