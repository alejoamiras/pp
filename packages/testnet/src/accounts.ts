import { actorAddressOf } from "@pp/asp-bot"
import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { KeySpec } from "./guards"

/** The account `createActor` deploys for an L2 secret at the committed salt, derived without a wallet or a network. */
export const l2AddressOf = (secret: Hex): Promise<Hex> => actorAddressOf(secret)

export const l1AddressOf = (key: Hex): Address => privateKeyToAccount(key).address

/** Every key's public address, by variable name; no network. */
export async function addressesOf(specs: readonly KeySpec[], keys: Record<string, Hex>): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	for (const { name, kind } of specs) {
		const key = keys[name] as Hex
		out[name] = kind === "l1" ? l1AddressOf(key) : await l2AddressOf(key)
	}
	return out
}
