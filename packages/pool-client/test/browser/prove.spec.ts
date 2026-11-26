import { expect, type Page, test } from "@playwright/test"
import type { EnsureResult, ProveResult } from "./page/main.ts"
import { offlineTransactWitness } from "../support/offline-witness.ts"

type Probe = { prove(path: string): Promise<ProveResult>; ensure(path: string): Promise<EnsureResult> }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const outside: string[] = []
const pageErrors: string[] = []

async function openProbe(page: Page): Promise<void> {
	await page.context().route("**/*", (route) => {
		const url = new URL(route.request().url())
		if (url.protocol === "data:" || url.protocol === "blob:" || LOOPBACK.has(url.hostname)) return route.continue()
		outside.push(url.href)
		return route.abort()
	})
	page.on("pageerror", (e) => pageErrors.push(e.message))
	await page.goto(process.env.POOL_CLIENT_PAGE_URL!)
	await page.waitForFunction(() => "probe" in globalThis, undefined, { timeout: 30_000 })
}

test.afterEach(() => {
	expect(pageErrors).toEqual([])
	expect(outside).toEqual([])
})

test("proves transact_1x1 in Chromium from gateway artifacts, cross-origin isolated", async ({ page }) => {
	await openProbe(page)
	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
	const r = await page.evaluate((path) => (globalThis as unknown as { probe: Probe }).probe.prove(path), "/ipfs")
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
	const r = await page.evaluate((path) => (globalThis as unknown as { probe: Probe }).probe.ensure(path), "/tampered")
	expect(r).toMatchObject({ ok: false, code: "ARTIFACT_MISMATCH", circuit: "transact_1x1", file: "provingKey" })
})
