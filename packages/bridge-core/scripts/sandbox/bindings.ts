/** A generation read back: what its deploy bound on L1 and registered on L2, before anything runs on it. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Address } from "viem"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "../../src/factory-abi"
import type { L1Ctx } from "../../src/flows"
import { hubTokenFor } from "../../src/hub-l2"
import type { BridgeBlock, ManifestToken } from "../../src/manifest-v2"
import { registerHub } from "../script-l2"
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

/** An Aztec `EthAddress` return as hex, whichever shape the simulator decodes it to. */
const ethHex = (v: unknown) => (typeof v === "bigint" ? `0x${v.toString(16).padStart(40, "0")}` : String(v))

/** Each `registered` token's hub entry is its manifest L2 token, whose `portal_for` is its portal;
 *  each `unregistered` one has no entry yet and registers on its first claim. */
export async function flowHubRegistrations(
	l2: { wallet: Wallet; from: AztecAddress },
	bridge: BridgeBlock,
	registered: ManifestToken[],
	unregistered: ManifestToken[],
): Promise<string> {
	const hub = await registerHub(l2.wallet, bridge.l2.hub)
	const from = l2.from.toString()
	for (const t of registered) {
		const l2Token = await hubTokenFor(hub, t.erc20, from)
		if (!same(l2Token ?? "", t.l2Token)) throw new Error(`${t.displaySymbol}: hub token_for is ${l2Token}, not ${t.l2Token}`)
		const r = (await hub.methods.portal_for(AztecAddress.fromStringUnsafe(t.l2Token)).simulate({ from: l2.from } as never)) as {
			result?: unknown
		}
		const portal = ethHex(r.result ?? r)
		if (!same(portal, t.portal)) throw new Error(`${t.displaySymbol}: hub portal_for is ${portal}, not ${t.portal}`)
	}
	for (const t of unregistered) {
		const l2Token = await hubTokenFor(hub, t.erc20, from)
		if (l2Token !== undefined) throw new Error(`${t.displaySymbol}: registered on the hub (${l2Token}) before any claim`)
	}
	return `${registered.length} registered with their portals, ${unregistered.length} left for a first claim`
}
