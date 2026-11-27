// Loads nothing but viem, so a package that only checks code imports it without the pool's clients.
import { type Address, getAddress, type Hex, keccak256, slice } from "viem"

export const EIP1967_IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

/** A proxy and the implementation its EIP-1967 slot names, each with the keccak256 of its runtime code. */
export type ContractCode = {
	proxy: Address
	proxyCodeHash: Hex
	implementation: Address
	implementationCodeHash: Hex
}

export const POOL_CONTRACTS = ["vault", "entrypoint", "keystore", "aspRegistry"] as const
export type PoolContract = (typeof POOL_CONTRACTS)[number]
export type PoolCode = Record<PoolContract, ContractCode>

/** The two reads, with viem's parameter names, so a viem `PublicClient` serves as one. */
export interface CodeReader {
	getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>
	getStorageAt(args: { address: Address; slot: Hex; blockNumber: bigint }): Promise<Hex | undefined>
}

/** keccak256 of empty code: what an absent contract or a cleared slot reads as, and never a valid pin. */
export const EMPTY_CODE_HASH: Hex = keccak256("0x")

/** viem reports empty code as `undefined`. */
const hashOf = (code: Hex | undefined): Hex => (code === undefined || code === "0x" ? EMPTY_CODE_HASH : keccak256(code))

async function readContract(client: CodeReader, proxy: Address, blockNumber: bigint): Promise<ContractCode> {
	const [code, slot] = await Promise.all([
		client.getCode({ address: proxy, blockNumber }),
		client.getStorageAt({ address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber }),
	])
	// A cleared slot reads as the zero address, whose empty code then differs from any pinned implementation.
	const implementation = getAddress(slice(slot ?? `0x${"00".repeat(32)}`, 12, 32))
	return {
		proxy: getAddress(proxy),
		proxyCodeHash: hashOf(code),
		implementation,
		implementationCodeHash: hashOf(await client.getCode({ address: implementation, blockNumber })),
	}
}

/**
 * The four contracts' code at `blockNumber`: per contract, its code, its EIP-1967 slot and its
 * implementation's code (twelve reads). `client` must serve every call at `blockNumber` or throw; one that
 * falls back to its head on a retry mixes snapshots and can hide an upgrade.
 */
export async function readPoolCode(client: CodeReader, pool: Record<PoolContract, Address>, blockNumber: bigint): Promise<PoolCode> {
	const read = await Promise.all(POOL_CONTRACTS.map((c) => readContract(client, pool[c], blockNumber)))
	return Object.fromEntries(POOL_CONTRACTS.map((c, i) => [c, read[i]])) as PoolCode
}

/** The fields of `got` that differ from `want`, named `code.<contract>.<field>`, compared without regard to case. */
export function codeMismatches(want: PoolCode, got: PoolCode): string[] {
	return POOL_CONTRACTS.flatMap((c) =>
		(Object.keys(want[c]) as (keyof ContractCode)[])
			.filter((f) => want[c][f].toLowerCase() !== got[c][f].toLowerCase())
			.map((f) => `code.${c}.${f}`),
	)
}
