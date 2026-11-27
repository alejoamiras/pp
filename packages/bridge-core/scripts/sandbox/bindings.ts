/** A generation read back: what its deploy bound on L1 and registered on L2, before anything runs on it. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Address, Hex } from "viem"
import { PORTAL_FACTORY_ABI } from "../../src/factory-abi"
import type { L1Ctx } from "../l1-ctx"
import { assertGenerationBindings, type RollupInfoSource, rollupEndpointsOf } from "../../src/generation-bindings"
import { hubTokenFor } from "../../src/hub-l2"
import type { BridgeBlock, ManifestToken } from "../../src/manifest-v2"
import { registerHub } from "../script-l2"
import { SANDBOX_LIFETIME_CAP, SANDBOX_POOL } from "./constants"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The manifest's generation is bound to the sandbox's vault and cap and to the rollup `node`
 *  follows, every manifest token's portal exists at its predicted address and holds that token, and
 *  entries are still paused. With `flowHubRegistrations`, that ties each hub `portal_for` to
 *  `predictPortal`. */
export async function flowGenerationBindings(l1: L1Ctx, node: RollupInfoSource, bridge: BridgeBlock): Promise<string> {
	const factory = bridge.l1.factory as Address
	await assertGenerationBindings(
		l1.pub,
		{
			factory,
			implementation: bridge.l1.implementation as Address,
			hub: bridge.l2.hub.address as Hex,
			guardian: bridge.l1.guardian as Address,
			...(await rollupEndpointsOf(node)),
			pool: SANDBOX_POOL,
			lifetimeCap: SANDBOX_LIFETIME_CAP,
			portals: bridge.tokens.map((t) => ({ token: t.erc20 as Address, portal: t.portal as Address })),
		},
		"sandbox generation",
	)
	for (const t of bridge.tokens) {
		const predicted = await l1.pub.readContract({
			address: factory,
			abi: PORTAL_FACTORY_ABI,
			functionName: "predictPortal",
			args: [t.erc20 as Address],
		})
		if (!same(predicted, t.portal)) throw new Error(`${t.displaySymbol}: predictPortal is ${predicted}, the manifest says ${t.portal}`)
	}
	if (!(await l1.pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })))
		throw new Error("entries are open on a generation whose vault is a placeholder")
	return `vault ${SANDBOX_POOL}, entries paused, ${bridge.tokens.length} portals bound at their predicted addresses`
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
