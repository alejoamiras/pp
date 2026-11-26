import { describe, expect, it } from "vitest"
import { flowPrivateDeposit, flowPublicDeposit, flowRelayedPrivateDeposit } from "../../scripts/sandbox/flows"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("deposits", () => {
	it("public deposit → claim_public on a registered token", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowPublicDeposit(a.s, usdc, await a.l2TokenOf(usdc))).toContain("claim, +")
	})

	it("private deposit → claim_private", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowPrivateDeposit(a.s, usdc, await a.l2TokenOf(usdc))).toContain("privately")
	})

	it("a relayer cannot redirect a private claim, then submits it for the actor", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowRelayedPrivateDeposit(a.s, usdc, await a.l2TokenOf(usdc))).toContain("wrong recipient rejected")
	})
})
