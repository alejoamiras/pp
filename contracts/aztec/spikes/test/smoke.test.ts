import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node"
import { createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client"
import { describe, expect, inject, it } from "vitest"

describe("smoke", () => {
	it("serves the node API and moves L2 time on request", async () => {
		const node = createAztecNodeClient(inject("nodeUrl"))
		await waitForNode(node)
		const before = await node.getBlock("latest")
		const t0 = before?.header.globalVariables.timestamp ?? 0n

		await createAztecNodeDebugClient(inject("nodeUrl")).warpL2TimeAtLeastBy(120)

		const after = await node.getBlock("latest")
		expect(after?.number ?? 0).toBeGreaterThan(before?.number ?? 0)
		expect(after?.header.globalVariables.timestamp ?? 0n).toBeGreaterThanOrEqual(t0 + 120n)
	})
})
