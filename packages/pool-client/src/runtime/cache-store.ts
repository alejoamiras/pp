import type { ICacheStore } from "../sdk.ts"

/** Bump when the stored layout changes, so an old cache is never read. */
export const ARTIFACT_CACHE_NAME = "pp-pool-client-artifacts-v1"
/** Cache Storage keys must be http(s) URLs; this one is never fetched. */
export const artifactCacheKey = (cid: string) => `https://artifacts.pool-client.invalid/${cid}`

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("")

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
}

/**
 * Artifacts kept across page loads in Cache Storage, or `undefined` where the runtime has none (Node, Bun).
 * An entry that no longer matches its pinned digest is deleted and read as a miss, so the loader refetches
 * instead of failing on a poisoned cache. Storage errors also read as misses: the cache is only a speed-up.
 */
export function cacheStorageStore(digestOf: (cid: string) => string | undefined): ICacheStore | undefined {
	if (typeof caches === "undefined") return undefined
	const open = () => caches.open(ARTIFACT_CACHE_NAME)
	return {
		async get(cid) {
			try {
				const cache = await open()
				const hit = await cache.match(artifactCacheKey(cid))
				if (hit === undefined) return null
				const bytes = new Uint8Array(await hit.arrayBuffer())
				if ((await sha256Hex(bytes)) === digestOf(cid)) return bytes
				await cache.delete(artifactCacheKey(cid))
				return null
			} catch {
				return null
			}
		},
		async set(cid, bytes) {
			try {
				await (await open()).put(artifactCacheKey(cid), new Response(bytes as Uint8Array<ArrayBuffer>))
			} catch {
				// Quota or private mode: the next load fetches again.
			}
		},
	}
}
