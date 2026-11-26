import { describe, expect, it } from "vitest"
import { flowGenerationBindings } from "../../scripts/sandbox/bindings"
import type { BridgeBlock } from "../../src/manifest-v2"
import { INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("generation", () => {
	it("binds the vault and cap, starts with entries paused, and creates one portal per manifest token", async () => {
		const { clients, manifest } = await sandbox()
		expect(await flowGenerationBindings(clients.l1, manifest.bridge as BridgeBlock)).toContain("entries paused")
	})
})
