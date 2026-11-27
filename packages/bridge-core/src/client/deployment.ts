import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import type { Address, Hex, PublicClient } from "viem"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { assertGenerationBindings, BindingMismatchError, type BindingsClient, rollupEndpointsOf } from "../generation-bindings"
import type { StackManifest } from "../stack-manifest"
import { guarded } from "./boundary"
import { BridgeClientError } from "./errors"
import { bridgeOf } from "./session"
import { type BridgeDeployment, deploymentId } from "./types"

/** What a manifest names for one bridge generation, copied out of it. */
export type NamedDeployment = Omit<BridgeDeployment, "rollupVersion"> & { factory: Address; hub: Hex }

export type ClientDeployment = BridgeDeployment & { id: string }

export type DeploymentReader = BindingsClient & Pick<PublicClient, "getChainId">

export type DeploymentNode = Pick<AztecNode, "getNodeInfo">

/** @throws BridgeClientError `DEPLOYMENT_MISMATCH` when the manifest carries no bridge. */
export function namedDeployment(m: StackManifest): NamedDeployment {
	const { factory, portal, hub, token, deployBlock } = bridgeOf(m)
	return { chainId: m.chainId, factory, portal, hub, token, asset: m.pool.asset, poolVault: m.pool.poolVault, deployBlock }
}

/**
 * `d` once the L1 RPC and the Aztec node agree with it: both are on its chain, and its portal is the
 * factory's clone for the pool's asset, bound to its hub, its vault and the rollup the node follows.
 * Reads are trusted, so this catches a manifest whose parts disagree or an endpoint on another chain,
 * not an RPC that lies consistently.
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
		const { factory: _, ...rest } = d
		return { ...rest, rollupVersion: rollup.rollupVersion, id: deploymentId(d) }
	})
}
