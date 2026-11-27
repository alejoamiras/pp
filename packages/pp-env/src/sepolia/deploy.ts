import { mkdir } from "node:fs/promises"
import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { checkout } from "../env/checkout.ts"
import { deployFixture, deployPool, enableAsset, ensureFixtures, mintTestToken } from "../env/deploy.ts"
import { ACCESS_ABI, assertCanonicalPoseidon, assertSepolia, hasPostman, POSTMAN_ROLE, sepolia } from "./chain.ts"
import { verifyPoolCode } from "./code.ts"
import type { DeployPoolOnOptions, SepoliaPool } from "./types.ts"

/**
 * Deploys the pinned pool to Sepolia through `DeployE2ELocal.runLocal()`, the path the local env
 * takes, with no state written by cheat code: the canonical Poseidon libraries must already be there.
 * Then grants `postman` the postman role, deploys the six-decimal test token, enables it and mints
 * `mint`, and checks every deployed contract's runtime code against the build.
 * @throws Error when either chain id is not 11155111, Poseidon's code is not canonical, forge would
 * recompile, any transaction fails, or a contract's code is not the build's; what already landed stays
 */
export async function deployPoolOn(o: DeployPoolOnOptions): Promise<SepoliaPool> {
	const log = o.log ?? (() => {})
	const client = createPublicClient({ transport: http(o.rpcUrl) })
	await assertSepolia(client, o.chainId)
	const co = checkout()
	await assertCanonicalPoseidon(client, co)
	await ensureFixtures()
	await mkdir(o.runDir, { recursive: true })
	const account = privateKeyToAccount(o.deployerKey)
	const before = await client.getBalance({ address: account.address })
	const deployment = await deployPool({
		rpcUrl: o.rpcUrl,
		co,
		deployerKey: o.deployerKey,
		deployer: account.address,
		workDir: o.runDir,
		client,
	})
	log(`pool deployed: entrypoint ${deployment.entrypoint}, vault ${deployment.pool}, from block ${deployment.deployBlock}`)
	const wallet = createWalletClient({ account, chain: sepolia, transport: http(o.rpcUrl) })
	if (o.postman !== undefined) {
		const hash = await wallet.writeContract({
			address: deployment.accessRouter,
			abi: ACCESS_ABI,
			functionName: "grantRole",
			args: [POSTMAN_ROLE, o.postman],
		})
		if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`grantRole ${hash} reverted`)
		if (!(await hasPostman(client, deployment.accessRouter, o.postman)))
			throw new Error(`${o.postman} lacks the postman role after its grant`)
		log(`postman role granted to ${o.postman}`)
	}
	const asset = await deployFixture(wallet, client, "TestToken")
	await enableAsset(wallet, client, deployment.entrypoint, asset)
	await mintTestToken(wallet, client, asset, o.mint.to, o.mint.amount)
	log(`test token ${asset} enabled; ${o.mint.amount} minted to ${o.mint.to}`)
	await verifyPoolCode({ rpcUrl: o.rpcUrl, chainId: o.chainId, deployment: { ...deployment, asset } })
	log("every deployed contract's runtime code matches the build")
	return { deployment, asset, spentWei: before - (await client.getBalance({ address: account.address })) }
}
