import type { Account, PublicClient, WalletClient } from "viem"

/** One L1 signer as the deploy and sandbox scripts use it: a public client, a wallet and its account. */
export interface L1Ctx {
	pub: PublicClient
	wallet: WalletClient
	account: Account
}
