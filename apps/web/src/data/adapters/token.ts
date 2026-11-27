/**
 * The asset's decimals and symbol as the factory froze them when it created the portal, so the page
 * shows amounts in the units the bridge moves. The page's main chunk reads them before it renders,
 * and it cannot load bridge-core (its barrel reaches aztec.js and the SponsoredFPC artifact), so the
 * one ABI entry and the word's decoding live here, pinned to bridge-core's by `token.test.ts`.
 */
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, hexToBytes, isAddressEqual, type PublicClient } from "viem"
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

/** The most decimals the app formats amounts in. */
const MAX_DECIMALS = 36

const isUint8 = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xff

/**
 * A factory word's text: `0x00 ‖ b0..b30`, printable ASCII up to its zero padding. `null` for any other
 * word, which no factory writes; the text is shown on the page.
 */
export function wordText(word: Hex): string | null {
	const bytes = hexToBytes(word, { size: 32 })
	const end = bytes.indexOf(0, 1)
	const text = bytes.subarray(1, end === -1 ? undefined : end)
	const padding = end === -1 ? [] : bytes.subarray(end)
	if (bytes[0] !== 0 || padding.some((b) => b !== 0) || text.some((b) => b < 0x20 || b > 0x7e)) return null
	return String.fromCharCode(...text)
}

/**
 * @throws `DEPLOYMENT_MISMATCH` when the factory registers no portal for `asset`, or another one than
 *   `portal`: the manifest then names a deployment this chain does not hold. The same when the record
 *   cannot be decoded, holds decimals that are not a uint8 in 0..36 (viem decodes the whole word), or a
 *   symbol word `wordText` refuses.
 */
export async function readToken(
	reads: Pick<PublicClient, "call">,
	o: { factory: Address; asset: Address; portal: Address },
): Promise<Pick<Deployment, "decimals" | "symbol">> {
	const abi = [REGISTRATION_OF]
	const { data } = await reads.call({ to: o.factory, data: encodeFunctionData({ abi, functionName: "registrationOf", args: [o.asset] }) })
	// Read and decoded apart, so a failed read stays an RPC failure and a malformed answer is the deployment's.
	let r: ReturnType<typeof decodeFunctionResult<typeof abi, "registrationOf">>
	try {
		r = decodeFunctionResult({ abi, functionName: "registrationOf", data: data ?? "0x" })
	} catch {
		throw new BridgeFailure("DEPLOYMENT_MISMATCH")
	}
	const symbol = wordText(r.symbolWord)
	if (!isAddressEqual(r.portal, o.portal) || !isUint8(r.decimals) || r.decimals > MAX_DECIMALS || symbol === null)
		throw new BridgeFailure("DEPLOYMENT_MISMATCH")
	return { decimals: r.decimals, symbol }
}
