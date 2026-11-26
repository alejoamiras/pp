import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { type AspSnapshot, type RootRecord, serializeAspSnapshot } from "@pp/label-paths"

type Held = { poolRoot: bigint; birthRoot: bigint; body: string }

/** Snapshots this process can back: the ones it posted and the record it found current at start. */
export class SnapshotBook {
	private readonly held = new Map<bigint, Held>()
	private current: bigint | null = null

	/** Throws if the snapshot's roots do not rebuild. */
	hold(s: AspSnapshot): void {
		this.held.set(s.sequence, { poolRoot: s.poolRoot, birthRoot: s.birthRoot, body: serializeAspSnapshot(s) })
	}

	has(sequence: bigint): boolean {
		return this.held.has(sequence)
	}

	/**
	 * Points `/latest` at the registry's current record, or at nothing when this process holds no snapshot
	 * with its roots: `set_poster` keeps the sequence but clears the roots.
	 */
	setCurrent(r: Pick<RootRecord, "sequence" | "poolRoot" | "birthRoot">): void {
		const h = this.held.get(r.sequence)
		this.current = h && h.poolRoot === r.poolRoot && h.birthRoot === r.birthRoot ? r.sequence : null
	}

	body(sequence: bigint | "latest"): string | undefined {
		const n = sequence === "latest" ? this.current : sequence
		return n === null ? undefined : this.held.get(n)?.body
	}
}

export type Reply = { status: number; headers: Record<string, string>; body: string }

const HEADERS = {
	"cache-control": "no-store",
	"access-control-allow-origin": "*",
	"cross-origin-resource-policy": "cross-origin",
}
const SEQUENCE = /^\/v1\/snapshots\/([1-9][0-9]{0,19})$/

/** The two snapshot routes. The query string is dropped unread, so no request can name a label. */
export function respond(method: string, url: string, book: SnapshotBook): Reply {
	if (method !== "GET") return { status: 405, headers: { ...HEADERS, allow: "GET" }, body: "" }
	const path = url.split("?", 1)[0]
	const digits = path?.match(SEQUENCE)?.[1]
	const body = path === "/v1/snapshots/latest" ? book.body("latest") : digits ? book.body(BigInt(digits)) : undefined
	if (body === undefined) return { status: 404, headers: HEADERS, body: "" }
	return { status: 200, headers: { ...HEADERS, "content-type": "application/json" }, body }
}

/** Listens on 127.0.0.1; `port` 0 picks a free one, reported in `url`. */
export async function serve(book: SnapshotBook, port = 0): Promise<{ url: string; port: number; close(): Promise<void> }> {
	const server: Server = createServer((req, res) => {
		const r = respond(req.method ?? "", req.url ?? "/", book)
		res.writeHead(r.status, r.headers).end(r.body)
	})
	await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, "127.0.0.1", ok))
	const bound = (server.address() as AddressInfo).port
	return {
		url: `http://127.0.0.1:${bound}`,
		port: bound,
		close: () => new Promise((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
	}
}
