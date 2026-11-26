/** A generation read back from L1: what its deploy bound, before anything runs on it. */
import type { Address } from "viem"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "../../src/factory-abi"
import type { L1Ctx } from "../../src/flows"
import type { BridgeBlock } from "../../src/manifest-v2"
import { SANDBOX_LIFETIME_CAP, SANDBOX_POOL } from "./constants"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The implementation names the sandbox's vault and cap, entries are still paused, and every manifest
 *  token's portal exists on chain and holds that token. */
export async function flowGenerationBindings(l1: L1Ctx, bridge: BridgeBlock): Promise<string> {
	const factory = bridge.l1.factory as Address
	const implementation = bridge.l1.implementation as Address
	const fromFactory = { address: factory, abi: PORTAL_FACTORY_ABI } as const
	const fromImplementation = { address: implementation, abi: PROCESSOR_PORTAL_ABI } as const
	const pool = await l1.pub.readContract({ ...fromImplementation, functionName: "POOL" })
	if (!same(pool, SANDBOX_POOL)) throw new Error(`implementation POOL is ${pool}, not ${SANDBOX_POOL}`)
	const cap = await l1.pub.readContract({ ...fromImplementation, functionName: "LIFETIME_CAP" })
	if (cap !== SANDBOX_LIFETIME_CAP) throw new Error(`implementation LIFETIME_CAP is ${cap}, not ${SANDBOX_LIFETIME_CAP}`)
	if (!(await l1.pub.readContract({ ...fromFactory, functionName: "entriesPaused" })))
		throw new Error("entries are open on a generation whose vault is a placeholder")
	for (const t of bridge.tokens) {
		const portal = await l1.pub.readContract({ ...fromFactory, functionName: "portalOf", args: [t.erc20 as Address] })
		if (!same(portal, t.portal)) throw new Error(`${t.displaySymbol}: portalOf is ${portal}, the manifest says ${t.portal}`)
		const held = await l1.pub.readContract({ address: portal, abi: PROCESSOR_PORTAL_ABI, functionName: "underlying" })
		if (!same(held, t.erc20)) throw new Error(`${t.displaySymbol}: portal ${portal} holds ${held}, not ${t.erc20}`)
	}
	return `vault ${pool}, entries paused, ${bridge.tokens.length} portals bound`
}
