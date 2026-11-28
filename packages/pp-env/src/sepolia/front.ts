import type { Address, Hex } from "viem"

/** What the front serves, read at each request. */
export type FrontState = {
	root(): bigint
	leaves(): readonly bigint[]
	publicKey: Hex
	snapshot(): Promise<unknown>
}

export type Front = { url: string; stop(): Promise<void> }

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Content-Type" }

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } })

type Route = { scoped: boolean; pathChain?: string; run(): unknown | Promise<unknown> }

function route(pathname: string, s: FrontState): Route | undefined {
	if (pathname === "/association-set/root") return { scoped: true, run: () => ({ root: s.root().toString() }) }
	if (pathname === "/association-set/leaves") return { scoped: true, run: () => ({ leaves: s.leaves().map(String) }) }
	if (pathname === "/public-key") return { scoped: false, run: () => ({ publicKey: s.publicKey }) }
	const snapshot = pathname.match(/^\/(\d+)\/public\/event-snapshot\/payload$/)
	if (snapshot) return { scoped: true, pathChain: snapshot[1], run: () => s.snapshot() }
	// Discovery takes the snapshot, then scans the chain from its end; the upstream mock answers 501 here too.
	const events = pathname.match(/^\/(\d+)\/public\/note-events$/)
	if (events) return { scoped: true, pathChain: events[1], run: () => undefined }
	return undefined
}

function scopeError(url: URL, r: Route, chainId: number, entrypoint: Address): Response | undefined {
	if (r.pathChain !== undefined && Number(r.pathChain) !== chainId) return json(404, { error: "unknown_chain" })
	const chain = url.searchParams.get("chainId")
	if (r.scoped && chain !== null && Number(chain) !== chainId)
		return json(400, { error: "scope_mismatch", message: "chainId does not match" })
	const ep = url.searchParams.get("entrypoint")
	if (r.scoped && ep !== null && ep.toLowerCase() !== entrypoint.toLowerCase())
		return json(400, { error: "scope_mismatch", message: "entrypoint does not match" })
	return undefined
}

/**
 * The mock ASP's whole HTTP surface: the read routes `HttpASPDataProvider` uses, `GET` only. No route
 * changes state, so any process that reaches the port can read the public set and nothing else;
 * `/admin/*` and every other path or method answer 404.
 */
export function startFront(o: { port: number; chainId: number; entrypoint: Address; state: FrontState }): Front {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: o.port,
		async fetch(req) {
			const url = new URL(req.url)
			const r = route(url.pathname, o.state)
			if (!r) return json(404, { error: "not_found" })
			if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
			if (req.method !== "GET") return json(404, { error: "not_found" })
			const refused = scopeError(url, r, o.chainId, o.entrypoint)
			if (refused) return refused
			const body = await r.run()
			return body === undefined ? json(501, { error: "not_implemented" }) : json(200, body)
		},
		error: () => json(500, { error: "internal_error" }),
	})
	let stopped: Promise<void> | undefined
	return { url: `http://127.0.0.1:${server.port}`, stop: () => (stopped ??= server.stop(true)) }
}
