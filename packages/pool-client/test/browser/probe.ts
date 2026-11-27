import { expect, type Page, test } from "@playwright/test"
import type { EnsureResult, ProveOn, ProveResult } from "./page/main.ts"

export type Probe = {
	prove(path: string, on?: ProveOn): Promise<ProveResult>
	ensure(path: string): Promise<EnsureResult>
	spend(input: string): Promise<string>
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const outside: string[] = []
const pageErrors: string[] = []

/** Every spec file using the probe asserts, after each test, that the page threw nothing and reached only loopback. */
export function fenceEachTest(): void {
	test.afterEach(() => {
		expect(pageErrors.splice(0)).toEqual([])
		expect(outside.splice(0)).toEqual([])
	})
}

export async function openProbe(page: Page, onRequest?: (url: URL) => void): Promise<void> {
	await page.context().route("**/*", (route) => {
		const url = new URL(route.request().url())
		onRequest?.(url)
		if (url.protocol === "data:" || url.protocol === "blob:" || LOOPBACK.has(url.hostname)) return route.continue()
		outside.push(url.href)
		return route.abort()
	})
	page.on("pageerror", (e) => pageErrors.push(e.message))
	await page.goto(process.env.POOL_CLIENT_PAGE_URL!)
	await page.waitForFunction(() => "probe" in globalThis, undefined, { timeout: 30_000 })
	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
}

export const probe = (page: Page) => ({
	prove: (path: string, on: ProveOn = "main") =>
		page.evaluate(([p, o]) => (globalThis as unknown as { probe: Probe }).probe.prove(p, o), [path, on] as const),
	ensure: (path: string) => page.evaluate((p) => (globalThis as unknown as { probe: Probe }).probe.ensure(p), path),
	spend: (input: string) => page.evaluate((i) => (globalThis as unknown as { probe: Probe }).probe.spend(i), input),
})
