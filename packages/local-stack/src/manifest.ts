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
}

/** The pool-only manifest of a local stack; later lanes add their blocks. `serializeStackManifest` validates it. */
export function buildManifest(i: ManifestInputs): StackManifest {
	return {
		version: 1,
		chainId: i.chainId,
		l1Rpc: i.l1Rpc,
		aztecNode: i.aztecNode,
		pool: { ...i.pool, asset: i.asset, aspApiUrl: i.aspUrl },
	}
}
