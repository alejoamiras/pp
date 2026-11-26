import { describe, expect, it } from "vitest"
import { flowGenerationBindings, flowHubRegistrations } from "../../scripts/sandbox/bindings"
import type { BridgeBlock } from "../../src/manifest-v2"
import { INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("generation", () => {
	it("binds the vault and cap, starts with entries paused, and creates one portal per manifest token", async () => {
		const { clients, manifest } = await sandbox()
		expect(await flowGenerationBindings(clients.l1, clients.l2.node, manifest.bridge as BridgeBlock)).toContain("entries paused")
	})

	it("registers the deployed tokens on the hub with their portals and leaves the portal-only one for its first claim", async () => {
		const { clients, manifest, usdc, usdt, pxo } = await sandbox()
		const l2 = { wallet: clients.l2.wallet, from: clients.l2.relayer }
		expect(await flowHubRegistrations(l2, manifest.bridge as BridgeBlock, [usdc, usdt], [pxo])).toContain("2 registered")
	})
})
