/**
 * Puts the checked proving points where the wallet's bundled bb.js looks first: IndexedDB
 * `keyval-store`, object store `keyval` (idb-keyval's defaults), shared by the extension's service
 * worker and its offscreen prover because they share the extension's origin. The worker fetches
 * from a loopback server, which needs CORP `cross-origin` under the extension's `require-corp`.
 */
import { createServer } from "node:http"
import type { Worker } from "@playwright/test"
import type { CrsPin, Pinned, SeedArrays } from "./crs"

export type CacheKey = keyof SeedArrays
export const CACHE_KEYS: CacheKey[] = ["g1Data", "g2Data", "grumpkinG1DataV2"]

export function pinnedCache(pin: CrsPin): Record<CacheKey, Pinned> {
	const { bytes: g2b, sha256: g2s } = pin.inputs["bn254_g2.dat"]
	const { bytes: gkb, sha256: gks } = pin.inputs["grumpkin_g1_v2.flat.dat"]
	return { g1Data: pin.g1Uncompressed, g2Data: { bytes: g2b, sha256: g2s }, grumpkinG1DataV2: { bytes: gkb, sha256: gks } }
}

export async function startSeedServer(arrays: SeedArrays): Promise<{ port: number; url: string; close(): Promise<void> }> {
	const server = createServer((req, res) => {
		const body = arrays[(req.url ?? "").slice(1) as CacheKey]
		if (!body) {
			res.writeHead(404).end()
			return
		}
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(body.length),
			"cross-origin-resource-policy": "cross-origin",
		})
		res.end(body)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const addr = server.address()
	if (!addr || typeof addr === "string") throw new Error("seed: no TCP address")
	return {
		port: addr.port,
		url: `http://127.0.0.1:${addr.port}`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	}
}

/** Writes the three arrays in one transaction and resolves only after it commits. */
export function seedCache(worker: Worker, url: string): Promise<Record<string, number>> {
	return worker.evaluate(
		async ({ base, keys }) => {
			const values: [string, Uint8Array][] = []
			for (const k of keys) {
				const res = await fetch(`${base}/${k}`)
				if (!res.ok) throw new Error(`seed: ${k} answered ${res.status}`)
				values.push([k, new Uint8Array(await res.arrayBuffer())])
			}
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const req = indexedDB.open("keyval-store")
				req.onupgradeneeded = () => req.result.createObjectStore("keyval")
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => reject(req.error)
			})
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction("keyval", "readwrite")
				for (const [k, v] of values) tx.objectStore("keyval").put(v, k)
				tx.oncomplete = () => resolve()
				tx.onerror = () => reject(tx.error)
				tx.onabort = () => reject(tx.error)
			})
			db.close()
			return Object.fromEntries(values.map(([k, v]) => [k, v.length]))
		},
		{ base: url, keys: CACHE_KEYS },
	)
}

/** Length and sha256 of each entry as the wallet would read it now; null when absent or not bytes. */
export function cacheHashes(worker: Worker): Promise<Record<string, Pinned | null>> {
	return worker.evaluate(async (keys) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open("keyval-store")
			req.onupgradeneeded = () => req.result.createObjectStore("keyval")
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		const out: Record<string, { bytes: number; sha256: string } | null> = {}
		for (const k of keys) {
			const v = await new Promise<unknown>((resolve, reject) => {
				const req = db.transaction("keyval").objectStore("keyval").get(k)
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => reject(req.error)
			})
			if (!(v instanceof Uint8Array) || !(v.buffer instanceof ArrayBuffer)) {
				out[k] = null
				continue
			}
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", v as Uint8Array<ArrayBuffer>))
			out[k] = { bytes: v.length, sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") }
		}
		db.close()
		return out
	}, CACHE_KEYS)
}
