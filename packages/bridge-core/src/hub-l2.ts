/** Reads of the L2 hub: its contract handle and its ERC-20 → token bindings. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractBase } from "@aztec-labs/aztec.js/contracts"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import { tokenBridgeHubArtifact } from "./artifacts"

export function hubAt(wallet: Wallet, hub: string): ContractBase {
	return Contract.at(AztecAddress.fromStringUnsafe(hub), tokenBridgeHubArtifact, wallet)
}

/** Opaque send options (fee + from + wait); the shape varies by wallet. */
export type SendOpts = Record<string, unknown>

const ZERO_FIELD = `0x${"0".repeat(64)}`

/** The one node read the binding needs; the full node client satisfies it. */
export interface PublicStorageReader {
	getPublicStorageAt(block: "latest", contract: AztecAddress, slot: Fr): Promise<Fr>
}

/** The `token_of` map's base slot, from the artifact the hub was deployed from. */
export function hubTokenOfSlot(): Fr {
	const slot = tokenBridgeHubArtifact.storageLayout.token_of?.slot
	if (!slot) throw new Error("the hub artifact declares no token_of storage")
	return slot
}

/**
 * The hub's binding for an ERC-20 without a wallet: the address sits first in the `WithHash`
 * the map's `PublicImmutable` packs, so the entry's own slot holds it, and zero — the value an
 * unwritten slot reads as — means unregistered, since the hub never binds to the zero address.
 */
export async function hubBindingAt(node: PublicStorageReader, hub: string, erc20: string): Promise<string | undefined> {
	const slot = await deriveStorageSlotInMap(hubTokenOfSlot(), EthAddress.fromString(erc20))
	const value = await node.getPublicStorageAt("latest", AztecAddress.fromStringUnsafe(hub), slot)
	return value.isZero() ? undefined : value.toString()
}

/**
 * The ASP registry the hub passes to its tokens, read as `hubBindingAt` reads a binding: the address
 * sits first in its `PublicImmutable`'s `WithHash`. Zero for a generation without checked spends.
 * Meaningful only for a hub of the committed artifact's class, whose layout names the slot.
 */
export async function hubRegistryAt(node: PublicStorageReader, hub: string): Promise<Fr> {
	const slot = tokenBridgeHubArtifact.storageLayout.registry?.slot
	if (!slot) throw new Error("the hub artifact declares no registry storage")
	return node.getPublicStorageAt("latest", AztecAddress.fromStringUnsafe(hub), slot)
}

/** The hub's binding for an ERC-20, or undefined when it has not registered it. */
export async function hubTokenFor(hub: ContractBase, erc20: string, from: string): Promise<string | undefined> {
	const r = (await hub.methods
		.token_for(EthAddress.fromString(erc20))
		.simulate({ from: AztecAddress.fromStringUnsafe(from) } as never)) as { result?: unknown }
	const addr = String(r.result ?? r)
	return addr.toLowerCase() === ZERO_FIELD ? undefined : addr
}
