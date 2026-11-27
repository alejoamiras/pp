import { laggingTolerant, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { type Address, createWalletClient, type Hex, http, isAddressEqual } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { GuardError } from "../guards"
import type { TestnetDeployment } from "../schema"

/**
 * An L1 wallet over the file's endpoint and chain for `key`, refused unless its address is `want`.
 * @throws GuardError `account` naming the role, never the key
 */
export function l1Wallet(d: TestnetDeployment, key: Hex, role: string, want?: Address) {
	const account = privateKeyToAccount(key)
	if (want && !isAddressEqual(account.address, want))
		throw new GuardError("account", `the ${role} key is for ${account.address}, the file expects ${want}`)
	return createWalletClient({
		account,
		chain: {
			id: d.network.l1ChainId,
			name: `chain ${d.network.l1ChainId}`,
			nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [d.network.l1Rpc] } },
		},
		transport: laggingTolerant(http(d.network.l1Rpc), PUBLIC_CHAIN_TIMING.pollingIntervalMs),
	})
}
