/**
 * The asset's decimals and symbol as the factory froze them when it created the portal, so the page
 * shows amounts in the units the bridge moves. The page's main chunk reads them before it renders,
 * and it cannot load bridge-core (its barrel reaches aztec.js and the SponsoredFPC artifact), so the
 * one ABI entry and the word's decoding live here, pinned to bridge-core's by `token.test.ts`.
 */
import { type Address, type Hex, hexToBytes, isAddressEqual, type PublicClient } from "viem"
import { BridgeFailure } from "../errors"
import type { Deployment } from "../ports"

export const REGISTRATION_OF = {
	type: "function",
	name: "registrationOf",
	stateMutability: "view",
	inputs: [{ name: "token", type: "address" }],
	outputs: [
		{
			name: "",
			type: "tuple",
			components: [
				{ name: "portal", type: "address" },
				{ name: "decimals", type: "uint8" },
				{ name: "registerIndex", type: "uint64" },
				{ name: "nameWord", type: "bytes32" },
				{ name: "symbolWord", type: "bytes32" },
				{ name: "registerKey", type: "bytes32" },
			],
		},
	],
} as const

/** A factory word, `0x00 ‖ b0..b30` of printable ASCII padded with zero bytes, as its text. */
export function wordText(word: Hex): string {
	const bytes = hexToBytes(word, { size: 32 }).subarray(1)
	const end = bytes.indexOf(0)
	return String.fromCharCode(...(end === -1 ? bytes : bytes.subarray(0, end)))
}

/**
 * @throws `DEPLOYMENT_MISMATCH` when the factory registers no portal for `asset`, or another one than
 *   `portal`: the manifest then names a deployment this chain does not hold.
 */
export async function readToken(
	reads: Pick<PublicClient, "readContract">,
	o: { factory: Address; asset: Address; portal: Address },
): Promise<Pick<Deployment, "decimals" | "symbol">> {
	const r = await reads.readContract({ address: o.factory, abi: [REGISTRATION_OF], functionName: "registrationOf", args: [o.asset] })
	if (!isAddressEqual(r.portal, o.portal)) throw new BridgeFailure("DEPLOYMENT_MISMATCH")
	return { decimals: r.decimals, symbol: wordText(r.symbolWord) }
}
