import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type Address, getAddress, type Hex, keccak256, type PublicClient, parseAbi, toBytes } from "viem"
import { sepolia } from "viem/chains"
import type { Checkout } from "../env/checkout.ts"
import { CANONICAL_CODE_FIXTURE, POSEIDON_LIBRARIES } from "../env/pins.ts"
import type { CodeMatch, SepoliaChainId } from "./types.ts"

export const SEPOLIA: SepoliaChainId = 11155111
export { sepolia }

export const POSTMAN_ROLE = keccak256(toBytes("POSTMAN_ROLE"))
export const ACCESS_ABI = parseAbi([
	"function grantRole(bytes32 role, address account)",
	"function hasRole(bytes32 role, address account) view returns (bool)",
])

/**
 * Refuses unless both the caller's `chainId` and the node's are 11155111. The argument is checked
 * at run time too: a JavaScript caller, or a cast, gets no help from the type.
 */
export async function assertSepolia(client: PublicClient, chainId: number): Promise<void> {
	if (chainId !== SEPOLIA) throw new Error(`chain ${chainId} refused: @pp/pp-env/sepolia runs on ${SEPOLIA} only`)
	const served = await client.getChainId()
	if (served !== SEPOLIA) throw new Error(`the node serves chain ${served}, not ${SEPOLIA}`)
}

/**
 * The pool links PoseidonT3 and PoseidonT4 at their canonical CREATE2 addresses and never deploys
 * them, so each must already hold exactly the canonical code.
 */
export async function assertCanonicalPoseidon(client: PublicClient, co: Checkout, blockNumber?: bigint): Promise<CodeMatch[]> {
	const fixture = JSON.parse(await readFile(join(co.src, CANONICAL_CODE_FIXTURE), "utf8")) as Record<string, { code: Hex }>
	const out: CodeMatch[] = []
	for (const { name, address } of POSEIDON_LIBRARIES) {
		const want = fixture[name]?.code
		if (!want) throw new Error(`${CANONICAL_CODE_FIXTURE} has no ${name}`)
		const code = await client.getCode({ address, ...(blockNumber !== undefined && { blockNumber }) })
		if (code?.toLowerCase() !== want.toLowerCase()) throw new Error(`${name} at ${address} does not hold the canonical code`)
		out.push({ name, address: getAddress(address) })
	}
	return out
}

export async function hasPostman(client: PublicClient, accessRouter: Address, who: Address): Promise<boolean> {
	return client.readContract({ address: accessRouter, abi: ACCESS_ABI, functionName: "hasRole", args: [POSTMAN_ROLE, who] })
}
