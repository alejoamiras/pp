import type { Hex } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { secretDerivationTypedData } from "../../src/keys.ts"

/** Anvil's public test mnemonic: these keys hold nothing outside a local chain. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"

export const anvilAccount = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index })

/** Anvil account `index`'s signature over the secret-derivation payload: its pool keys. */
export async function derivationSignature(index: number): Promise<Hex> {
	const account = anvilAccount(index)
	return account.signTypedData(secretDerivationTypedData(account.address))
}
