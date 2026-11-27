import type { Hex as SdkHex } from "#ppv2/evm-sdk"
import { createPublicClient, createWalletClient, http, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { openPoolUser } from "../client/pool.ts"
import { checkout } from "../env/checkout.ts"
import { assertSepolia, SEPOLIA, sepolia } from "./chain.ts"
import type { SepoliaPoolUser, SepoliaUserOptions } from "./types.ts"

/**
 * A pool user for `key` on Sepolia, proving with the fetched checkout's circuits under `circuitBundle`.
 * The wallet is built here from the key, so no viem object crosses to a caller on another viem copy.
 * @throws Error when either chain id is not 11155111
 */
export async function sepoliaPoolUser(o: SepoliaUserOptions): Promise<SepoliaPoolUser> {
	await assertSepolia(createPublicClient({ transport: http(o.rpcUrl) }), o.chainId)
	const chain = { ...sepolia, rpcUrls: { default: { http: [o.rpcUrl] } } }
	const wallet = createWalletClient({ account: privateKeyToAccount(o.key), chain, transport: http(o.rpcUrl) })
	const { rpcUrl, deployment, aspUrl, circuitBundle } = o
	const config = { rpcUrl, chainId: SEPOLIA, deployment, aspUrl, circuitsDir: checkout().circuits }
	const { user, session } = await openPoolUser(circuitBundle === undefined ? config : { ...config, circuitBundle }, { wallet })
	return {
		...user,
		async depositFor({ asset, value, recipient }) {
			// No out-of-band fallback: an unregistered recipient throws here, before anything is signed.
			const prepared = await session.prepareDepositFor({
				tokenId: asset,
				value: toHex(value) as SdkHex,
				discoveryData: { evmAddress: recipient },
			})
			if (prepared.noteSecret !== undefined) throw new Error(`the deposit for ${recipient} carries no on-chain announcement`)
			const receipt = await session.executeDeposit(prepared)
			if (!receipt.status) throw new Error(`the deposit for ${recipient} reverted`)
			return { label: BigInt(prepared.pendingNote.label), commitment: BigInt(prepared.pendingNote.commitment) }
		},
	}
}
