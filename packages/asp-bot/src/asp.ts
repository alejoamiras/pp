const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

/** The ASP API's current leaves (`GET /association-set/leaves`), in its order; the caller checks they hash to the chain's root. */
export async function fetchLeaves(aspApiUrl: string, timeoutMs = 10_000): Promise<bigint[]> {
	const base = aspApiUrl.endsWith("/") ? aspApiUrl : `${aspApiUrl}/`
	const res = await fetch(new URL("association-set/leaves", base), { signal: AbortSignal.timeout(timeoutMs) })
	if (!res.ok) throw new Error(`association-set/leaves: HTTP ${res.status}`)
	const { leaves } = (await res.json()) as { leaves?: unknown }
	if (!Array.isArray(leaves) || !leaves.every((l) => typeof l === "string" && DECIMAL.test(l))) {
		throw new Error("association-set/leaves: not a list of decimal strings")
	}
	return leaves.map((l) => BigInt(l))
}
