/** Fixed values of the sandbox network the harness deploys onto. None is a credential. */
import { GasFees } from "@aztec-labs/stdlib/gas"
import { type Address, defineChain, type Hex } from "viem"
import { mnemonicToAccount } from "viem/accounts"

export const CHAIN_ID = 31337
export const ZERO_L1 = "0x0000000000000000000000000000000000000000" as Address
/** The local sequencer prices L2 gas orders of magnitude above the old default; a lower ceiling
 *  rejects every setup tx with "maxFeesPerGas.feePerL2Gas must be >= gasFees". */
export const FEE_CEILING = { maxFeesPerGas: new GasFees(10n ** 13n, 10n ** 13n) }

/** Anvil's default mnemonic — the local network's too: its block publisher and validator both sign
 *  from index 0, so that index belongs to the node. The harness signs from the LAST funded index,
 *  the actors from the ones between; a key shared with the node's publisher races every L1 write
 *  on one nonce, and the generation deploy binds the deployer's next CREATE address. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
/** How many keys anvil is started with; every index the harness or an actor uses must be below it. */
export const ANVIL_ACCOUNTS = 16
export const HARNESS_INDEX = ANVIL_ACCOUNTS - 1
export function anvilKey(index: number): Hex {
	const hd = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey()
	const key = hd.privateKey
	if (!key) throw new Error(`anvil account ${index} has no private key`)
	return `0x${Buffer.from(key).toString("hex")}` as Hex
}
/** Deploys, relays, and is `l1` in every flow. */
export const HARNESS_KEY = anvilKey(HARNESS_INDEX)

export interface TokenSpec {
	name: string
	symbol: string
	decimals: number
}

export const SPECS = {
	usdc: { name: "Test USDC", symbol: "USDC", decimals: 6 },
	usdt: { name: "Test USDT", symbol: "USDT", decimals: 6 },
	pxo: { name: "Portal Only", symbol: "PXO", decimals: 18 },
} satisfies Record<string, TokenSpec>
export type SpecKey = keyof typeof SPECS

export const sandboxChain = (rpcUrl: string) =>
	defineChain({
		id: CHAIN_ID,
		name: "sandbox",
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
	})

export const lc = (v: string) => v.toLowerCase() as Address
