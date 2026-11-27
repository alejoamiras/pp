import { expect, type Page, test } from "@playwright/test"
import { PINNED_CIRCUITS } from "../../src/runtime/artifacts.ts"
import { ARTIFACT_CACHE_NAME, artifactCacheKey } from "../../src/runtime/cache-store.ts"
import { fenceEachTest, openProbe, probe } from "./probe.ts"

fenceEachTest()

const zkeyCid = PINNED_CIRCUITS.transact_1x1!.provingKey

async function reload(page: Page): Promise<void> {
	await page.reload()
	await page.waitForFunction(() => "probe" in globalThis, undefined, { timeout: 30_000 })
}

test("a reload proves from the artifact cache without fetching", async ({ page }) => {
	const fetched: string[] = []
	await openProbe(page, (url) => url.pathname.startsWith("/ipfs/") && fetched.push(url.pathname))
	expect((await probe(page).prove("/ipfs")).verified).toBe(true)
	expect(fetched).toHaveLength(3)

	fetched.length = 0
	await reload(page)
	const r = await probe(page).prove("/ipfs")
	expect(r.verified).toBe(true)
	expect(fetched).toEqual([])
	console.log(`[pool-client] transact_1x1 in Chromium from cache: load ${Math.round(r.loadMs)} ms, prove ${Math.round(r.proveMs)} ms`)
})

test("a tampered cache entry is dropped and fetched again", async ({ page }) => {
	const fetched: string[] = []
	await openProbe(page, (url) => url.pathname.startsWith("/ipfs/") && fetched.push(url.pathname))
	expect(await probe(page).ensure("/ipfs")).toEqual({ ok: true })

	await page.evaluate(
		async ([name, key]) => {
			const cache = await caches.open(name)
			const bytes = new Uint8Array(await (await cache.match(key))!.arrayBuffer())
			bytes[bytes.length >> 1]! ^= 1
			await cache.put(key, new Response(bytes))
		},
		[ARTIFACT_CACHE_NAME, artifactCacheKey(zkeyCid)] as const,
	)
	fetched.length = 0
	await reload(page)
	expect(await probe(page).ensure("/ipfs")).toEqual({ ok: true })
	expect(fetched).toEqual([`/ipfs/${zkeyCid}`])

	fetched.length = 0
	await reload(page)
	expect(await probe(page).ensure("/ipfs")).toEqual({ ok: true })
	expect(fetched).toEqual([])
})
