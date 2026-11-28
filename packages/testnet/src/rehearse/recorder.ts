/** A loopback HTTP front that forwards each request to `upstream` unchanged and keeps what reached it. */

export type Recorded = {
	method: string
	path: string
	query: Record<string, string>
	/** Every request header but `host`, as the client sent it. */
	headers: Record<string, string>
	bodyBytes: number
	/** The upstream's status, or 502 when it could not be reached. */
	status: number
}

export type Recorder = { url: string; requests: Recorded[]; stop(): Promise<void> }

/** Response headers that describe the upstream body as sent, which `fetch` has already decoded. */
const BODY_HEADERS = ["content-length", "content-encoding", "transfer-encoding"]

/** Listens on `port` (already claimed by the caller) at 127.0.0.1. */
export function startRecorder(o: { port: number; upstream: string }): Recorder {
	const requests: Recorded[] = []
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: o.port,
		async fetch(req) {
			const url = new URL(req.url)
			const body = await req.arrayBuffer()
			const headers = Object.fromEntries([...req.headers].filter(([k]) => k !== "host"))
			const seen = {
				method: req.method,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				headers,
				bodyBytes: body.byteLength,
			}
			const res = await fetch(new URL(url.pathname + url.search, o.upstream), {
				method: req.method,
				headers,
				body: body.byteLength > 0 ? body : undefined,
				redirect: "manual",
			}).catch(() => undefined)
			requests.push({ ...seen, status: res?.status ?? 502 })
			if (!res) return new Response(null, { status: 502 })
			const out = new Headers(res.headers)
			for (const h of BODY_HEADERS) out.delete(h)
			return new Response(await res.arrayBuffer(), { status: res.status, headers: out })
		},
	})
	let stopped: Promise<void> | undefined
	return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => (stopped ??= server.stop(true)) }
}
