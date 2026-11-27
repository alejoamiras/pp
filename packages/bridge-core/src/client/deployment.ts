import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { type Address, getAbiItem, type Hex, type PublicClient } from "viem"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { assertGenerationBindings, BindingMismatchError, type BindingsClient, rollupEndpointsOf } from "../generation-bindings"
import { hubBindingAt } from "../hub-l2"
import type { StackManifest } from "../stack-manifest"
import { guarded } from "./boundary"
import { BridgeClientError } from "./errors"
import { windowedLogs } from "./resolve"
import { bridgeOf } from "./session"
import { type BridgeDeployment, deploymentId } from "./types"

const PORTAL_CREATED = getAbiItem({ abi: PORTAL_FACTORY_ABI, name: "PortalCreated" })

/** What a manifest names for one bridge generation, copied out of it. */
export type NamedDeployment = Omit<BridgeDeployment, "rollupVersion"> & { factory: Address; hub: Hex }

/** A checked deployment; `outbox` is the Outbox the portal and the node both name. */
export type ClientDeployment = BridgeDeployment & { id: string; outbox: Address }

export type DeploymentReader = BindingsClient & Pick<PublicClient, "getChainId" | "getBlockNumber" | "getLogs">

export type DeploymentNode = Pick<AztecNode, "getNodeInfo" | "getPublicStorageAt">

/** @throws BridgeClientError `DEPLOYMENT_MISMATCH` when the manifest carries no bridge. */
export function namedDeployment(m: StackManifest): NamedDeployment {
	const { factory, portal, hub, token, deployBlock } = bridgeOf(m)
	return { chainId: m.chainId, factory, portal, hub, token, asset: m.pool.asset, poolVault: m.pool.poolVault, deployBlock }
}

/**
 * `d` once the L1 RPC and the Aztec node agree with it: both are on its chain; its portal is the
 * factory's clone for the pool's asset, bound to its hub, its vault and the rollup the node follows;
 * the hub binds the asset to its token; and the portal was created at or after its scan start, which
 * every bridge lookup begins from. Reads are trusted, so this catches a manifest whose parts disagree
 * or an endpoint on another chain, not an RPC that lies consistently.
 * @throws BridgeClientError `CHAIN_MISMATCH`, `DEPLOYMENT_MISMATCH`; `RPC_FAILED` when a read fails
 */
export function verifyDeployment(reader: DeploymentReader, node: DeploymentNode, d: NamedDeployment): Promise<ClientDeployment> {
	return guarded(async () => {
		const [chainId, info] = await Promise.all([reader.getChainId(), node.getNodeInfo()])
		if (chainId !== d.chainId || info.l1ChainId !== d.chainId) throw new BridgeClientError("CHAIN_MISMATCH")
		const rollup = await rollupEndpointsOf({ getNodeInfo: async () => info })
		const factory = { address: d.factory, abi: PORTAL_FACTORY_ABI } as const
		const implementation = await reader.readContract({ ...factory, functionName: "IMPLEMENTATION" })
		// The client has no expectation of its own for the guardian or the cap; it takes the chain's,
		// so what the check binds is the hub, the rollup, the vault and the portal.
		const [guardian, lifetimeCap] = await Promise.all([
			reader.readContract({ ...factory, functionName: "owner" }),
			reader.readContract({ address: implementation, abi: PROCESSOR_PORTAL_ABI, functionName: "LIFETIME_CAP" }),
		])
		const expected = { factory: d.factory, implementation, hub: d.hub, guardian, ...rollup, pool: d.poolVault, lifetimeCap }
		await assertGenerationBindings(reader, { ...expected, portals: [{ token: d.asset, portal: d.portal }] }, "client").catch((e) => {
			throw e instanceof BindingMismatchError ? new BridgeClientError("DEPLOYMENT_MISMATCH") : e
		})
		const token = await hubBindingAt(node, d.hub, d.asset)
		if (token === undefined || BigInt(token) !== BigInt(d.token)) throw new BridgeClientError("DEPLOYMENT_MISMATCH")
		// Uncached: a portal created within viem's cache window must be inside the scan.
		const head = await reader.getBlockNumber({ cacheTime: 0 })
		const created = await windowedLogs(d.deployBlock, head, true, (fromBlock, toBlock) =>
			reader.getLogs({ address: d.factory, event: PORTAL_CREATED, args: { token: d.asset, portal: d.portal }, fromBlock, toBlock }),
		)
		if (!created.length) throw new BridgeClientError("DEPLOYMENT_MISMATCH")
		const { factory: _, ...rest } = d
		return { ...rest, rollupVersion: rollup.rollupVersion, outbox: rollup.outbox, id: deploymentId(d) }
	})
}
