/**
 * The target of a testnet build (`vite build --mode testnet`), read from the deployment file at
 * `PP_DEPLOYMENT` and nothing else. The page talks to the node and the L1 RPC directly, both pinned,
 * and to the ASP and the bot through the app's own server (`SAME_ORIGIN`). It serves the own pool or
 * the operator's `pool1`, each with the default ceremony bundle, which the app already pins.
 */
import { isPinned, parseDeployment, requireSections } from "@pp/testnet/schema"
import { SAME_ORIGIN } from "./same-origin.ts"
import { attempt, fail, type PublicTarget, readJson, type TargetEnv } from "./target.ts"

const SEPOLIA = 11_155_111

/** Inputs of the other modes; any of them beside `PP_DEPLOYMENT` is a mistake about which build this is. */
const OTHER_INPUTS = ["PP_STACK_MANIFEST", "PP_SANDBOX_ARTIFACTS", "PP_DATA", "PP_WEB_WALLETS"] as const

/** The deployment at `file`, with its pool and bridge, refused unless it is the own pool or pool1 on Sepolia over pinned endpoints. */
export function readTestnetDeployment(file: string) {
	const json = readJson(file)
	const d = attempt(file, () => requireSections(parseDeployment(json), ["pool", "bridge"]))
	if (d.bundle !== "ceremony")
		fail(file, `proves with the ${d.bundle} bundle; a testnet build proves with the ceremony bundle the app pins`)
	if (d.network.l1ChainId !== SEPOLIA) fail(file, `is for L1 chain ${d.network.l1ChainId}; a testnet build is for Sepolia (${SEPOLIA})`)
	if (!isPinned("l1Rpc", d.network.l1Rpc)) fail(file, `network.l1Rpc ${d.network.l1Rpc} is not a pinned Sepolia RPC`)
	// The page never sends through it, but a file naming an unpinned endpoint anywhere is refused.
	if (d.network.l1SendRpc !== undefined && !isPinned("l1SendRpc", d.network.l1SendRpc))
		fail(file, `network.l1SendRpc ${d.network.l1SendRpc} is not the pinned Sepolia send RPC`)
	if (!isPinned("aztecNode", d.network.aztecNode)) fail(file, `network.aztecNode ${d.network.aztecNode} is not the pinned testnet node`)
	return d
}

/**
 * The public target for the deployment at `file`. `fpc` is the canonical SponsoredFPC, derived at
 * build time; the file must name the same one.
 *
 * @throws when another mode's input is set (even empty), the file fails `readTestnetDeployment`, or its FPC differs.
 */
export function testnetTarget(file: string | undefined, env: TargetEnv, fpc: string): PublicTarget {
	if (!file) fail("PP_DEPLOYMENT", "is not set; a testnet build reads its deployment file")
	for (const name of OTHER_INPUTS) if (env[name] !== undefined) fail(name, "is set; a testnet build reads PP_DEPLOYMENT alone")
	return testnetTargetOf(file, readTestnetDeployment(file), fpc)
}

/** `testnetTarget` over a deployment already read from `file`, built field by field. */
export function testnetTargetOf(file: string, d: ReturnType<typeof readTestnetDeployment>, fpc: string): PublicTarget {
	const { network: n, pool: p, bridge: b } = d
	if (n.fpc.toLowerCase() !== fpc.toLowerCase()) fail(file, `network.fpc ${n.fpc} is not the canonical SponsoredFPC ${fpc}`)
	return {
		nodeUrl: n.aztecNode,
		l1RpcUrl: n.l1Rpc,
		l1ChainId: n.l1ChainId,
		rollupVersion: n.rollupVersion,
		walletUrls: [],
		dataMode: "stack",
		connector: "real",
		stack: {
			manifest: {
				version: 1,
				chainId: n.l1ChainId,
				l1Rpc: n.l1Rpc,
				aztecNode: n.aztecNode,
				pool: {
					poolVault: p.poolVault,
					entrypoint: p.entrypoint,
					aspRegistry: p.aspRegistry,
					keystore: p.keystore,
					asset: p.asset,
					deployBlock: p.deployBlock.toString(),
					aspApiUrl: SAME_ORIGIN.asp,
				},
				bridge: {
					factory: b.factory,
					portal: b.portal,
					hub: b.hub,
					token: b.token,
					registry: b.registry,
					deployBlock: b.deployBlock.toString(),
				},
			},
			botUrl: SAME_ORIGIN.bot,
			sponsoredFpc: fpc,
			demoSender: null,
		},
	}
}
