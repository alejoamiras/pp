import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { type AspKind, type ProxyConfig, proxyRoute } from "./proxy"

const hex = fc.string({ unit: fc.constantFrom(..."0123456789abcdefABCDEF"), minLength: 40, maxLength: 40 })
// Above 1023: a claimed port, never a default one a URL parser would drop.
const port = fc.integer({ min: 1_024, max: 65_535 })
// What `serve` passes: a loopback origin for the bot, and for the ASP a loopback or pinned https origin.
const config: fc.Arbitrary<ProxyConfig> = fc.record({
	chainId: fc.integer({ min: 1, max: 2 ** 32 }),
	entrypoint: hex.map((h) => `0x${h}`),
	asp: fc.oneof(
		port.map((p) => `http://127.0.0.1:${p}`),
		fc.constant("https://asp.example"),
	),
	bot: port.map((p) => `http://127.0.0.1:${p}`),
	operator: fc.boolean(),
})

/** Each ASP route's upstream path and query keys in order; written out here so the property shares no table with the code. */
const ASP: Record<AspKind, { path: (c: ProxyConfig) => string; query: ReadonlyArray<string> }> = {
	root: { path: () => "/association-set/root", query: ["chainId", "entrypoint"] },
	leaves: { path: () => "/association-set/leaves", query: ["chainId", "entrypoint"] },
	"public-key": { path: () => "/public-key", query: [] },
	snapshot: { path: (c) => `/${c.chainId}/public/event-snapshot/payload`, query: ["entrypoint"] },
	"note-events": { path: (c) => `/${c.chainId}/public/note-events`, query: ["entrypoint", "since", "until"] },
}

/** Pieces that try to climb out, change host, or smuggle a query or fragment. */
const HOSTILE = [
	"..",
	".",
	"%2e%2e",
	"%2E",
	".%2e",
	"%2f",
	"%5c",
	"\\",
	"@evil.example",
	"evil.example",
	":80",
	"#x",
	"?",
	"&",
	"=",
	"%",
	"//",
	"",
]
const PIECES = [
	...HOSTILE,
	"asp",
	"bot",
	"v1",
	"snapshots",
	"latest",
	"1",
	"007",
	"association-set",
	"root",
	"leaves",
	"public-key",
	"{c}",
	"admin",
]
const PREFIX = ["/", "//", "/asp/", "/asp", "/bot/", "/bot/v1/snapshots/", "/asp/association-set/", "/asp/{c}/public/", "\\", "/\\"]

/** A target each route accepts: the SDK's spelling, the keys swapped, the entrypoint in another case. */
function valid(c: ProxyConfig): fc.Arbitrary<string> {
	const ep = fc.constantFrom(c.entrypoint, c.entrypoint.toLowerCase(), `0x${c.entrypoint.slice(2).toUpperCase()}`)
	const block = fc.option(fc.bigInt({ min: 0n, max: 10n ** 78n - 1n }), { nil: undefined })
	return fc.oneof(
		fc.constantFrom("latest", "1", "42", "9".repeat(20)).map((s) => `/bot/v1/snapshots/${s}`),
		fc
			.tuple(fc.constantFrom("root", "leaves"), fc.boolean(), ep)
			.map(
				([k, swap, e]) =>
					`/asp/association-set/${k}?${swap ? `entrypoint=${e}&chainId=${c.chainId}` : `chainId=${c.chainId}&entrypoint=${e}`}`,
			),
		fc.constant("/asp/public-key"),
		ep.map((e) => `/asp/${c.chainId}/public/event-snapshot/payload?entrypoint=${e}`),
		fc
			.tuple(ep, block, block)
			.map(
				([e, s, u]) =>
					`/asp/${c.chainId}/public/note-events?entrypoint=${e}${s === undefined ? "" : `&since=${s}`}${u === undefined ? "" : `&until=${u}`}`,
			),
	)
}

function target(c: ProxyConfig): fc.Arbitrary<string> {
	const ok = valid(c)
	// One hostile piece put anywhere in an accepted target: the edge where a check slips.
	const near = fc.tuple(ok, fc.nat(), fc.constantFrom(...HOSTILE)).map(([t, at, s]) => {
		const i = at % (t.length + 1)
		return `${t.slice(0, i)}${s}${t.slice(i)}`
	})
	const piece = fc.constantFrom(...PIECES).map((s) => s.replace("{c}", String(c.chainId)))
	const value = fc.oneof(
		fc.constantFrom(String(c.chainId), c.entrypoint, "12", "0x", "%40", "http://evil", "1e3"),
		fc.string({ maxLength: 6 }),
	)
	const query = fc.array(
		fc.tuple(fc.constantFrom("chainId", "entrypoint", "since", "until", "CHAINID", "label", ""), value).map(([k, v]) => `${k}=${v}`),
		{ maxLength: 4 },
	)
	const pieced = fc
		.tuple(fc.constantFrom(...PREFIX), fc.array(piece, { maxLength: 5 }), fc.option(query, { nil: undefined }))
		.map(([p, parts, q]) => `${p.replace("{c}", String(c.chainId))}${parts.join("/")}${q === undefined ? "" : `?${q.join("&")}`}`)
	return fc.oneof(ok, near, pieced, fc.string({ unit: "binary-ascii", maxLength: 40 }))
}

/** Fails unless the route is exactly one of its upstream's URLs, as a URL parser reads it, scoped to `c`. */
function staysOnItsUpstream(raw: string, c: ProxyConfig, reached: Map<string, number>): void {
	const r = proxyRoute(raw, c)
	if (r === null) return
	reached.set(r.upstream === "bot" ? "bot" : r.kind, (reached.get(r.upstream === "bot" ? "bot" : r.kind) ?? 0) + 1)
	const url = new URL(r.url)
	expect(url.href, "a URL parser moves nothing").toBe(r.url)
	if (r.upstream === "bot") {
		expect(url.origin).toBe(c.bot)
		expect(url.pathname).toMatch(/^\/v1\/snapshots\/(latest|[1-9][0-9]{0,19})$/)
		expect(url.search + url.hash).toBe("")
		return
	}
	const { path, query } = ASP[r.kind]
	const keys = [...url.searchParams.keys()]
	expect(keys, "each key once, in the SDK's order").toEqual(query.filter((k) => keys.includes(k)))
	expect(keys).toEqual(expect.arrayContaining(query.filter((k) => k === "chainId" || k === "entrypoint")))
	for (const [k, v] of url.searchParams) {
		if (k === "chainId") expect(v).toBe(String(c.chainId))
		else if (k === "entrypoint") expect(v).toBe(c.entrypoint)
		else expect(v).toMatch(/^[0-9]{1,78}$/)
	}
	const search = keys.map((k) => `${k}=${url.searchParams.get(k)}`).join("&")
	expect(r.url).toBe(`${c.asp}${path(c)}${search === "" ? "" : `?${search}`}`)
}

describe("proxyRoute", () => {
	const name = "never leaves its upstream: a route is one of its upstream's exact URLs, scoped to the configured pool"
	const p = propertyParams(import.meta.url, name, 3_000, 10_000)
	it(
		name,
		() => {
			const reached = new Map<string, number>()
			fc.assert(
				fc.property(
					config.chain((c) => fc.tuple(fc.constant(c), target(c))),
					([c, raw]) => staysOnItsUpstream(raw, c, reached),
				),
				p.fc,
			)
			// Every route is reached, so the property speaks for each of them.
			for (const k of ["bot", ...Object.keys(ASP)]) expect(reached.get(k) ?? 0, k).toBeGreaterThan(0)
		},
		p.testTimeout,
	)
})
