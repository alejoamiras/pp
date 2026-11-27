/**
 * A loopback JSON-RPC relay for a client that cannot wrap its own transport, such as forge's broadcast:
 * sends take a {@link SendPath}, every other call goes to its read endpoint. forge 1.7.1 under
 * `--skip-simulation` re-sends a failed send without its gas limit and hangs on a sent transaction the
 * read endpoint never shows, so the relay keeps the read side from ever looking older than what it served:
 *
 * - a sender's latest or pending nonce is never answered below one past the last of its transactions whose
 *   receipt the relay served, a receipt counting only when it names that transaction's hash and a hex block
 *   number;
 * - an `eth_estimateGas` error within `freshMs` of such a receipt's first serving is asked again until
 *   `freshMs` has passed or the request's budget ends; an error it then gives up on is answered as it came;
 * - a null receipt of a transaction the relay sent is asked again until it is not null or the request's
 *   budget ends: forge asks three times without a pause once it has seen the transaction in a block, and a
 *   backend whose nodes lag each other can answer null all three times;
 * - a read the endpoint refused or answered ambiguously (HTTP 429 or 5xx, a refusal alloy repeats, a broken
 *   connection, an unreadable body) is asked again inside the request's budget.
 *
 * The listener holds a request for as long as its budget, past Bun's default idle timeout.
 *
 * Whatever the relay gives up on answers JSON-RPC -32000 with the endpoint's words in `data`, a shape
 * neither alloy's nor viem's retries repeat, so the relay is the one place that re-sends.
 */
import { claimPort, releaseNamed } from "@pp/run-isolation/ports"
import type { Hex } from "viem"
import { classifyThrown, isHead, isRefusal, parseAnswer, postJson, SendPath, SendPathError, type SendPathOptions } from "./send-path.ts"

const SERVICE = "send-relay"
const JSON_HEADERS = { "content-type": "application/json" }
const MAX_BODY = 4 * 1024 * 1024
/** Seconds a connection may wait on its answer: above forge's 45 s request timeout and every budget here. */
const IDLE_TIMEOUT_S = 60
const HEX_QUANTITY = /^0x[0-9a-f]+$/i

export type RelayTuning = {
	/** The registry owner of the relay's port row; default one per process. */
	owner?: string
	/** How long after a served receipt an estimate error is asked again; default 30 s. */
	freshMs?: number
	/** One read's budget for asking again; default 35 s, under forge's 45 s request timeout. */
	readBudgetMs?: number
}

/**
 * The relay's own path, or a caller's `path` that its other sends share, so its nonce claims and floor
 * span both; the relay closes only a path it made.
 */
export type SendRelayOptions = RelayTuning & ({ path: SendPath } | SendPathOptions)

export type SendRelay = {
	/** `http://127.0.0.1:<port>`, listening from the moment the relay is returned. */
	url: string
	path: SendPath
	/** When the relay started or last served a new receipt for a transaction it sent. */
	lastProgressAt(): number
	/** How many of the relay's sends it has served a receipt for. */
	landed(): number
	/** Every send the path did not admit, in order. */
	failures(): readonly SendPathError[]
	/**
	 * Closes the listener, ends the watches and sends of a path the relay made, and drops the port row. Idempotent.
	 * @throws Error when the registry did not drop the row; the row's liveness reaping still frees it
	 */
	stop(): Promise<void>
}

type Call = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type Reply = { status: number; text: string }

const reply = (id: unknown, body: Record<string, unknown>): Reply => ({
	status: 200,
	text: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
})
const gaveUp = (id: unknown, message: string, data?: string): Reply =>
	reply(id, { error: { code: -32000, message, ...(data === undefined ? {} : { data }) } })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

class Relay {
	private readonly floor = new Map<string, number>()
	readonly receipted = new Set<Hex>()
	readonly failures: SendPathError[] = []
	private lastReceiptAt = 0
	progressAt = Date.now()

	readonly path: SendPath
	private readonly freshMs: number
	private readonly readBudgetMs: number

	constructor(path: SendPath, freshMs: number, readBudgetMs: number) {
		this.path = path
		this.freshMs = freshMs
		this.readBudgetMs = readBudgetMs
	}

	private async readOnce(body: string, timeoutMs: number): Promise<Reply | string> {
		try {
			const r = await postJson(this.path.o.readUrl, body, timeoutMs)
			if (r.status === 429 || r.status >= 500) return `HTTP ${r.status}`
			if (r.status !== 200) return r
			const a = parseAnswer(r.text)
			if (a === undefined) return "an unreadable body"
			if (a.error && isRefusal(a.error)) return `${a.error.code} ${String(a.error.message ?? "")}`
			return r
		} catch (e) {
			return classifyThrown(e).kind
		}
	}

	/** One read, asked again while the endpoint refuses or `again` says so, inside the read budget. */
	private async read(c: Call, again: (r: Reply) => boolean = () => false): Promise<Reply> {
		const body = JSON.stringify(c)
		const deadline = Date.now() + this.readBudgetMs
		let last: Reply | string = "no answer"
		// The last real answer, which outranks a later refusal: a revert must not come back as a 503.
		let answered: Reply | undefined
		for (let wait = this.path.o.delayMs; Date.now() < deadline; wait = Math.min(wait * 2, 2_000)) {
			last = await this.readOnce(body, Math.max(1, deadline - Date.now()))
			if (typeof last !== "string") {
				if (!again(last)) return last
				answered = last
			}
			if (Date.now() + wait >= deadline) break
			await sleep(wait)
		}
		if (answered) return answered
		return typeof last === "string" ? gaveUp(c.id, `${String(c.method)} was not answered within ${this.readBudgetMs} ms`, last) : last
	}

	private async send(c: Call): Promise<Reply> {
		const raw = Array.isArray(c.params) ? c.params[0] : undefined
		if (typeof raw !== "string") return gaveUp(c.id, "refused: no raw transaction")
		try {
			return reply(c.id, { result: await this.path.send(raw as Hex) })
		} catch (e) {
			if (!(e instanceof SendPathError)) return gaveUp(c.id, `send failed: ${(e as Error).message}`)
			this.failures.push(e)
			if (e.kind === "final" && e.upstream) return { status: e.upstream.status, text: e.upstream.body }
			return gaveUp(c.id, e.message, e.data)
		}
	}

	private nonceFloor(c: Call, r: Reply): Reply {
		const [address, tag] = Array.isArray(c.params) ? c.params : []
		const who = typeof address === "string" && isHead(tag) ? address.toLowerCase() : ""
		const floor = this.floor.get(who)
		const a = parseAnswer(r.text)
		if (floor === undefined || typeof a?.result !== "string" || BigInt(a.result) >= BigInt(floor)) return r
		return reply(c.id, { result: `0x${floor.toString(16)}` })
	}

	/** The transaction this relay sent whose hash `c` asks about, if any. */
	private sentTx(c: Call) {
		const hash = Array.isArray(c.params) ? c.params[0] : undefined
		return typeof hash === "string" ? this.path.sent.get(hash.toLowerCase() as Hex) : undefined
	}

	private noteReceipt(c: Call, r: Reply): void {
		const tx = this.sentTx(c)
		const receipt = parseAnswer(r.text)?.result as { transactionHash?: unknown; blockNumber?: unknown } | null | undefined
		const names = typeof receipt?.transactionHash === "string" && receipt.transactionHash.toLowerCase() === tx?.hash
		const inBlock = typeof receipt?.blockNumber === "string" && HEX_QUANTITY.test(receipt.blockNumber)
		if (!tx || !names || !inBlock || this.receipted.has(tx.hash)) return
		const who = tx.sender.toLowerCase()
		this.floor.set(who, Math.max(this.floor.get(who) ?? 0, tx.nonce + 1))
		this.receipted.add(tx.hash)
		this.lastReceiptAt = Date.now()
		this.progressAt = Date.now()
	}

	async one(c: Call): Promise<Reply> {
		switch (c.method) {
			case "eth_sendRawTransaction":
				return this.send(c)
			case "eth_getTransactionCount":
				return this.nonceFloor(c, await this.read(c))
			case "eth_estimateGas":
				return this.read(c, (r) => parseAnswer(r.text)?.error !== undefined && Date.now() - this.lastReceiptAt < this.freshMs)
			case "eth_getTransactionReceipt": {
				const ours = this.sentTx(c) !== undefined
				const r = await this.read(c, (a) => ours && parseAnswer(a.text)?.result === null)
				this.noteReceipt(c, r)
				return r
			}
			default:
				return this.read(c)
		}
	}
}

async function handle(relay: Relay, req: Request): Promise<Response> {
	if (req.method !== "POST") return new Response("POST only", { status: 405 })
	const body = await req.text()
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
	}
	if (Array.isArray(parsed)) {
		const replies = await Promise.all(parsed.map((c: Call) => relay.one(c)))
		return new Response(`[${replies.map((r) => r.text).join(",")}]`, { headers: JSON_HEADERS })
	}
	const r = await relay.one(parsed as Call)
	return new Response(r.text, { status: r.status, headers: JSON_HEADERS })
}

/**
 * Starts the relay on a loopback port claimed in the host registry, in this process, listening before it
 * returns. The caller stops it when its client is done; a process that dies leaves its row to the
 * registry's reaping.
 * @throws Error when no port could be claimed or bound; nothing is left listening or registered
 */
export async function startSendRelay(o: SendRelayOptions): Promise<SendRelay> {
	const owned = !("path" in o)
	const path = "path" in o ? o.path : new SendPath(o)
	const relay = new Relay(path, o.freshMs ?? 30_000, o.readBudgetMs ?? 35_000)
	const owner = o.owner ?? `pp-send-relay-${process.pid}`
	const port = await claimPort(owner, SERVICE)
	const release = () => releaseNamed([{ port, service: SERVICE, owner }])
	let server: ReturnType<typeof Bun.serve>
	try {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			maxRequestBodySize: MAX_BODY,
			idleTimeout: IDLE_TIMEOUT_S,
			fetch: (req) => handle(relay, req),
		})
	} catch (e) {
		await release()
		throw e
	}
	let stopped = false
	return {
		url: `http://127.0.0.1:${port}`,
		path,
		lastProgressAt: () => relay.progressAt,
		landed: () => relay.receipted.size,
		failures: () => relay.failures,
		async stop() {
			if (stopped) return
			stopped = true
			if (owned) path.close()
			await server.stop(true)
			if (!(await release())) throw new Error(`the port registry did not drop the send relay's row for port ${port}`)
		},
	}
}
