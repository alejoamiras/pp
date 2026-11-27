import { readFileSync } from "node:fs"
import { createPublicClient, http, isAddressEqual } from "viem"
import type { TestProject } from "vitest/node"
import { PORTAL_FACTORY_ABI } from "../../../src/factory-abi"
import { parseStackManifest, requireBlocks } from "../../../src/stack-manifest"

declare module "vitest" {
	export interface ProvidedContext {
		manifestPath: string
	}
}

/**
 * Attaches to the stack PP_STACK_MANIFEST names and refuses one that is not a live local stack with
 * an open bridge: a manifest can outlive the stack that wrote it.
 */
export default async function setup(project: TestProject): Promise<void> {
	const path = process.env.PP_STACK_MANIFEST
	if (!path)
		throw new Error("PP_STACK_MANIFEST is unset: run `bun run test:integration:stack`, which boots a stack when none is attached")
	const m = requireBlocks(parseStackManifest(JSON.parse(readFileSync(path, "utf8"))), ["bridge"])
	if (m.chainId !== 31337) throw new Error(`the stack suite runs on chain 31337 only, not ${m.chainId}`)
	const client = createPublicClient({ transport: http(m.l1Rpc) })
	const chainId = await client.getChainId()
	if (chainId !== m.chainId) throw new Error(`${m.l1Rpc} serves chain ${chainId}, the manifest says ${m.chainId}`)
	for (const [name, address] of [
		["factory", m.bridge.factory],
		["portal", m.bridge.portal],
		["pool", m.pool.poolVault],
	] as const)
		if (!(await client.getCode({ address }))) throw new Error(`no code at the manifest's ${name} ${address}`)
	const read = <N extends "portalOf" | "L2_HUB" | "entriesPaused">(functionName: N, args: readonly unknown[] = []) =>
		client.readContract({ address: m.bridge.factory, abi: PORTAL_FACTORY_ABI, functionName, args } as never) as Promise<unknown>
	if (!isAddressEqual((await read("portalOf", [m.pool.asset])) as `0x${string}`, m.bridge.portal))
		throw new Error("the factory's portal for the pool asset is not the manifest's portal")
	if (String(await read("L2_HUB")).toLowerCase() !== m.bridge.hub.toLowerCase())
		throw new Error("the factory's hub is not the manifest's hub")
	if (await read("entriesPaused")) throw new Error("the stack's bridge entries are paused")
	project.provide("manifestPath", path)
}
