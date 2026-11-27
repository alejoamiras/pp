import type { Hex } from "@pp/label-paths"

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

/** One pool of a multi-pool ASP API; the public one answers 404 without both. */
export type AspScope = { chainId: number; entrypoint: Hex }

const leavesUrl = (aspApiUrl: string) => new URL("association-set/leaves", aspApiUrl.endsWith("/") ? aspApiUrl : `${aspApiUrl}/`)

async function leavesAt(url: URL, timeoutMs: number): Promise<bigint[]> {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
	if (!res.ok) throw new Error(`association-set/leaves: HTTP ${res.status}`)
	const { leaves } = (await res.json()) as { leaves?: unknown }
	if (!Array.isArray(leaves) || !leaves.every((l) => typeof l === "string" && DECIMAL.test(l))) {
		throw new Error("association-set/leaves: not a list of decimal strings")
	}
	return leaves.map((l) => BigInt(l))
}

/** The ASP API's current leaves (`GET /association-set/leaves`), in its order; the caller checks they hash to the chain's root. */
export async function fetchLeaves(aspApiUrl: string, timeoutMs = 10_000): Promise<bigint[]> {
	return leavesAt(leavesUrl(aspApiUrl), timeoutMs)
}

/** {@link fetchLeaves} for one pool, named by `?chainId=&entrypoint=`; the caller checks the leaves hash to that pool's root. */
export async function fetchScopedLeaves(aspApiUrl: string, scope: AspScope, timeoutMs = 10_000): Promise<bigint[]> {
	const url = leavesUrl(aspApiUrl)
	url.searchParams.set("chainId", String(scope.chainId))
	url.searchParams.set("entrypoint", scope.entrypoint)
	return leavesAt(url, timeoutMs)
}
