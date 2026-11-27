import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { createPoolUser } from "../client/pool.ts"
import type { PoolUser } from "../client/types.ts"
import { checkout } from "../env/checkout.ts"
import { assertSepolia, SEPOLIA, sepolia } from "./chain.ts"
import type { SepoliaUserOptions } from "./types.ts"

/**
 * A pool user for `key` on Sepolia, proving with the fetched checkout's circuits under `circuitBundle`.
 * The wallet is built here from the key, so no viem object crosses to a caller on another viem copy.
 * @throws Error when either chain id is not 11155111
 */
export async function sepoliaPoolUser(o: SepoliaUserOptions): Promise<PoolUser> {
	await assertSepolia(createPublicClient({ transport: http(o.rpcUrl) }), o.chainId)
	const chain = { ...sepolia, rpcUrls: { default: { http: [o.rpcUrl] } } }
	const wallet = createWalletClient({ account: privateKeyToAccount(o.key), chain, transport: http(o.rpcUrl) })
	const { rpcUrl, deployment, aspUrl, circuitBundle } = o
	const config = { rpcUrl, chainId: SEPOLIA, deployment, aspUrl, circuitsDir: checkout().circuits }
	return createPoolUser(circuitBundle === undefined ? config : { ...config, circuitBundle }, { wallet })
}
