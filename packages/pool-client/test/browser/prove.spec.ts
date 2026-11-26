import { expect, test } from "@playwright/test"
import { offlineTransactWitness } from "../support/offline-witness.ts"
import { fenceEachTest, openProbe, probe } from "./probe.ts"

fenceEachTest()

test("proves transact_1x1 in Chromium from gateway artifacts, cross-origin isolated", async ({ page }) => {
	await openProbe(page)
	const r = await probe(page).prove("/ipfs")
	console.log(`[pool-client] transact_1x1 in Chromium: load ${Math.round(r.loadMs)} ms, prove ${Math.round(r.proveMs)} ms`)
	expect(r.verified).toBe(true)
	const spend = await offlineTransactWitness()
	expect(r.signals.map(BigInt)).toEqual([
		spend.nullifier,
		spend.changeCommitment,
		expect.any(BigInt),
		expect.any(BigInt),
		expect.any(BigInt),
		spend.amount,
		spend.asset,
		spend.context,
	])
})

test("refuses a served zkey with one changed byte as ARTIFACT_MISMATCH", async ({ page }) => {
	await openProbe(page)
	expect(await probe(page).ensure("/tampered")).toMatchObject({
		ok: false,
		code: "ARTIFACT_MISMATCH",
		circuit: "transact_1x1",
		file: "provingKey",
	})
})
