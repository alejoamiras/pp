import { describe, expect, it } from "vitest"
import {
	flowGuardianPause,
	flowL1Pause,
	flowOutboxRoundTrip,
	flowPrivateDeposit,
	flowPublicDeposit,
	runExit,
} from "../../scripts/sandbox/flows"
import { type ActorContext, freshActor, INTEGRATION, sandbox } from "./sandbox"

/** A fresh actor holding something to exit. */
async function funded(kind: "public" | "private"): Promise<ActorContext> {
	const a = await freshActor()
	const { usdc } = await sandbox()
	const l2Token = await a.l2TokenOf(usdc)
	if (kind === "public") await flowPublicDeposit(a.s, usdc, l2Token)
	else await flowPrivateDeposit(a.s, usdc, l2Token)
	return a
}

describe.skipIf(!INTEGRATION)("exits", () => {
	it("public exit → Outbox consume releases on L1", async () => {
		const a = await funded("public")
		const { usdc } = await sandbox()
		const unit = 10n ** BigInt(usdc.decimals)
		expect(await runExit(a.s, { token: usdc, l2Token: await a.l2TokenOf(usdc), amount: 10n * unit, isPrivate: false })).toContain(
			"released",
		)
	})

	it("private exit → Outbox consume releases on L1", async () => {
		const a = await funded("private")
		const { usdc } = await sandbox()
		const unit = 10n ** BigInt(usdc.decimals)
		expect(await runExit(a.s, { token: usdc, l2Token: await a.l2TokenOf(usdc), amount: 5n * unit, isPrivate: true })).toContain(
			"released",
		)
	})

	it("the guardian pause blocks exits, not claims, and is always lifted", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowGuardianPause(a.s, usdc)).toContain("unpaused")
	})

	it("the factory pause makes every portal refuse deposits and withdraws first, and is always lifted", async () => {
		const a = await freshActor()
		const { usdc } = await sandbox()
		expect(await flowL1Pause(a.s, usdc)).toContain("WithdrawsPaused")
	})

	it("an exit reads as not consumed at proposal and as consumed once finalized", async () => {
		const a = await funded("public")
		const { usdc } = await sandbox()
		expect(await flowOutboxRoundTrip(a.s, usdc, await a.l2TokenOf(usdc))).toContain("reads as consumed")
	})
})
