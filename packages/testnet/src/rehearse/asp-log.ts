import type { Recorded } from "./recorder"

/** A step's name and the index of the first request recorded in it. */
export type Mark = readonly [step: string, from: number]

export type AspLine = { line: string; carried: readonly string[] }

/**
 * Each request through the ASP front under the step it arrived in, with its User-Agent and the names of
 * the accounts its path, query or headers carry. An account is a 20-byte L1 or 32-byte L2 address in
 * `named`, matched without its `0x` and in any case.
 */
export function aspLines(tag: string, requests: readonly Recorded[], marks: readonly Mark[], named: Record<string, string>): AspLine[] {
	const accounts = Object.entries(named).filter(([, v]) => /^0x[0-9a-f]{40}([0-9a-f]{24})?$/i.test(v))
	return requests.map((r, i) => {
		const step = marks.filter(([, from]) => from <= i).at(-1)?.[0] ?? "setup"
		const seen = [r.path, ...Object.values(r.query), ...Object.values(r.headers)].join(" ").toLowerCase()
		const carried = accounts.filter(([, v]) => seen.includes(v.slice(2).toLowerCase())).map(([k]) => k)
		const query = new URLSearchParams(r.query).toString()
		const agent = r.headers["user-agent"] ?? "no user-agent"
		const line = `[${tag}] asp ${step}: ${r.method} ${r.path}${query ? `?${query}` : ""} (${agent}) -> ${r.status}; carries ${carried.join(", ") || "no named account"}`
		return { line, carried }
	})
}
