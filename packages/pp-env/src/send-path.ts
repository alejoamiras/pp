/**
 * The send rules every keyed L1 send follows, whether forge's (through the loopback relay) or a viem
 * wallet's: `eth_sendRawTransaction` goes to the send endpoint, every other call to the read endpoint.
 *
 * Before a send leaves, its envelope is decoded: it must be of type 0, 1 or 2, for the expected chain id,
 * signed by one of the expected addresses, and no other transaction of that sender's at that nonce may
 * have gone out through this path. Only the bytes received are forwarded, and their hash is computed
 * here. Success is an allow-list: the endpoint answered the local hash, or exactly "already known" or
 * "transaction already imported" (a hash commits to the exact signed bytes), or a lookup found the hash.
 * Each answer is classified:
 *
 * - the local hash: admitted. Another hash: refused at once.
 * - exactly "already known" or "transaction already imported", in any case: admitted.
 * - "nonce too low" or "replacement (transaction) underpriced": admitted if either endpoint knows the
 *   local hash; else a conflict, reported with the hash and nonce.
 * - refused (HTTP 429 or 503, a JSON-RPC error alloy retries, a connection refused before the write) and
 *   ambiguous (a timeout, a reset, HTTP 500, 502 or 504, an unreadable body): the same bytes go again,
 *   inside one budget shorter than forge's 45 s request timeout, the last attempt just before it ends.
 *   Then either endpoint knowing the hash makes it admitted; else it fails, with the hash and nonce.
 * - anything else, however worded: admitted if either endpoint knows the local hash; else final, passed
 *   through as the endpoint gave it, and the same bytes sent again get that answer without leaving.
 *
 * An endpoint knows a transaction when it answers `eth_getTransactionByHash` with HTTP 200 and that hash.
 * After an admission the read endpoint must show the hash within `visibilityMs`; each time it does not,
 * the same bytes go to the send endpoint again, until an answer other than an admission or a refusal.
 * Every attempt and answer goes to `journal`. Both endpoints are fetched with redirects refused.
 */
import { type Address, type Hex, isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress } from "viem"

const KNOWN = /^\s*(?:already known|transaction already imported)\s*$/i
const CONFLICT = /\bnonce too low\b|\breplacement (?:transaction )?underpriced\b/i
/** Codes alloy-json-rpc 2.0.1 retries whatever the message, and those it retries with a message part. */
const RETRIED_CODES = new Set([429, -32005, 1008, -32055])
const RETRIED_WITH: ReadonlyMap<number, string> = new Map([
	[-32016, "rate limit"],
	[-32012, "credits"],
	[-32007, "request limit reached"],
])
const RETRIED_EXACT = new Set(["header not found", "daily request count exceeded, request rate limited"])
const RETRIED_PARTS = [
	"rate limit",
	"rate exceeded",
	"too many requests",
	"credits limited",
	"request limit",
	"maximum number of concurrent requests",
]
/** Typed envelopes a send may carry: legacy, EIP-2930, EIP-1559. */
const TYPES: ReadonlySet<string> = new Set(["legacy", "eip2930", "eip1559"])
/** Upstream words go to the send log; a raw transaction an endpoint echoes back is cut to its length. */
const LONG_HEX = /0x[0-9a-fA-F]{80,}/g
const MAX_DETAIL = 300
const REFUSED_STATUS = new Set([429, 503])
const JSON_HEADERS = { "content-type": "application/json" }

export type SendPathOptions = {
	readUrl: string
	sendUrl: string
	chainId: number
	/** The addresses a send may come from; any other recovered sender is refused before forwarding. */
	senders: readonly Address[]
	/** One send's whole budget for re-sends, before the final lookups; default 35 s. */
	budgetMs?: number
	/** One attempt's deadline, cut to what the budget has left; default 10 s. */
	attemptTimeoutMs?: number
	/** The first wait between attempts, doubled up to 4 s; default 500 ms. */
	delayMs?: number
	/** How long the read endpoint gets to show an admitted hash before the bytes go again; default 30 s. */
	visibilityMs?: number
	/** How often the read endpoint is asked for an admitted hash; default 2 s. */
	visibilityPollMs?: number
	/** Re-pushes after which an invisible send is left to the caller's own deadline; default 4. */
	rePushes?: number
	journal?: (entry: JournalEntry) => void
}

/** One line of the send log: public data only, never a key or a raw transaction. */
export type JournalEntry = {
	at: string
	hash: Hex
	nonce: number
	endpoint: "send" | "read"
	event: string
}

export type SentTx = { hash: Hex; nonce: number; sender: Address }

export type SendPathErrorKind = "envelope" | "nonce" | "final" | "other-hash" | "conflict" | "budget" | "closed"

/**
 * Why a send was not admitted. `upstream` holds a final answer as the endpoint gave it; `data` the
 * endpoint's words for a refusal, kept out of `message` so no client reads a rate limit into it and retries.
 */
export class SendPathError extends Error {
	readonly kind: SendPathErrorKind
	readonly tx?: SentTx
	readonly upstream?: { status: number; body: string }
	readonly data?: string

	constructor(kind: SendPathErrorKind, message: string, tx?: SentTx, upstream?: { status: number; body: string }, data?: string) {
		super(message)
		this.name = "SendPathError"
		this.kind = kind
		this.tx = tx
		this.upstream = upstream
		this.data = data
	}
}

export type Outcome =
	| { kind: "admitted" }
	| { kind: "known" }
	| { kind: "other-hash"; got: string }
	| { kind: "conflict"; detail: string }
	| { kind: "refused"; detail: string }
	| { kind: "ambiguous"; detail: string }
	| { kind: "final"; status: number; body: string; detail: string }

type Answer = { result?: unknown; error?: { code?: unknown; message?: unknown } }

export function parseAnswer(text: string): Answer | undefined {
	try {
		const a: unknown = JSON.parse(text)
		return a !== null && typeof a === "object" && !Array.isArray(a) ? (a as Answer) : undefined
	} catch {
		return undefined
	}
}

/**
 * Whether alloy would repeat this error answer on its own: `ErrorPayload::is_retry_err` of
 * alloy-json-rpc 2.0.1, the version forge 1.7.1 carries, rule for rule and case-sensitive. Here such an
 * answer is a refusal, re-sent inside the budget, so no client re-sends behind the path.
 */
export function isRefusal(error: NonNullable<Answer["error"]>): boolean {
	const code = Number(error.code)
	const message = String(error.message ?? "")
	if (RETRIED_CODES.has(code)) return true
	const part = RETRIED_WITH.get(code)
	if (part !== undefined && message.includes(part)) return true
	return RETRIED_EXACT.has(message) || RETRIED_PARTS.some((p) => message.includes(p))
}

function classifyError(status: number, text: string, error: NonNullable<Answer["error"]>): Outcome {
	const message = String(error.message ?? "")
	const detail = `${error.code} ${message}`
	if (KNOWN.test(message)) return { kind: "known" }
	if (CONFLICT.test(message)) return { kind: "conflict", detail }
	if (isRefusal(error)) return { kind: "refused", detail }
	return { kind: "final", status, body: text, detail }
}

/** Classifies one endpoint answer to a send of the transaction whose hash is `hash`. */
export function classifySend(status: number, text: string, hash: Hex): Outcome {
	if (REFUSED_STATUS.has(status)) return { kind: "refused", detail: `HTTP ${status}` }
	if (status >= 500) return { kind: "ambiguous", detail: `HTTP ${status}` }
	if (status !== 200) return { kind: "final", status, body: text, detail: `HTTP ${status}` }
	const a = parseAnswer(text)
	if (a?.error !== undefined && a.error !== null) return classifyError(status, text, a.error)
	if (typeof a?.result === "string") return a.result.toLowerCase() === hash ? { kind: "admitted" } : { kind: "other-hash", got: a.result }
	return { kind: "ambiguous", detail: "an unreadable body" }
}

/** A fetch that threw: refused when the connection was refused before anything was written, else ambiguous. */
export function classifyThrown(e: unknown): Outcome {
	const code = (e as { code?: unknown })?.code
	if (code === "ConnectionRefused" || code === "ECONNREFUSED") return { kind: "refused", detail: "connection refused" }
	return { kind: "ambiguous", detail: e instanceof Error ? `${e.name}${code ? ` ${String(code)}` : ""}` : "a broken connection" }
}

/**
 * The transaction a raw send carries, if it may be sent: its chain id is `chainId` and its recovered
 * sender is one of `senders`.
 * @throws SendPathError (`envelope`) for undecodable bytes, a type other than 0, 1 or 2, another or no chain id, or another sender
 */
export async function checkEnvelope(raw: Hex, chainId: number, senders: readonly Address[]): Promise<SentTx> {
	let tx: ReturnType<typeof parseTransaction>
	let sender: Address
	try {
		tx = parseTransaction(raw)
		sender = await recoverTransactionAddress({
			serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"],
		})
	} catch (e) {
		throw new SendPathError("envelope", `refused: the raw transaction does not decode (${(e as Error).message.split("\n")[0]})`)
	}
	const hash = keccak256(raw)
	if (!TYPES.has(String(tx.type)))
		throw new SendPathError("envelope", `refused: ${hash} is a ${tx.type} transaction; only types 0, 1 and 2 are sent`)
	const nonce = Number(tx.nonce ?? 0)
	if (tx.chainId !== chainId) throw new SendPathError("envelope", `refused: ${hash} is for chain ${tx.chainId ?? "none"}, not ${chainId}`)
	if (!senders.some((s) => isAddressEqual(s, sender)))
		throw new SendPathError("envelope", `refused: ${hash} is signed by ${sender}, which this command does not send from`)
	return { hash, nonce, sender }
}

export async function postJson(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
	const res = await fetch(url, { method: "POST", headers: JSON_HEADERS, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
	return { status: res.status, text: await res.text() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const short = (event: string) => event.replace(LONG_HEX, (h) => `${h.slice(0, 10)}…(${(h.length - 2) / 2} bytes)`).slice(0, MAX_DETAIL)
/** Whether an `eth_getTransactionByHash` answer names `hash`: anything else is no proof. */
const names = (status: number, text: string, hash: Hex) => {
	const r = parseAnswer(text)?.result as { hash?: unknown } | null | undefined
	return status === 200 && typeof r?.hash === "string" && r.hash.toLowerCase() === hash
}
/** A block tag a nonce floor applies to: the latest or pending count, not a historical one. */
export const isHead = (tag: unknown) => tag === undefined || tag === "latest" || tag === "pending"
/** A wait that does not hold the process open, for the watches that outlive a command's last send. */
const idle = (ms: number) =>
	new Promise<void>((r) => {
		const t = setTimeout(r, ms) as { unref?: () => void }
		t.unref?.()
	})
const LOOKUP_TIMEOUT_MS = 3_000

type Resolved = Required<Omit<SendPathOptions, "journal">> & { journal: (entry: JournalEntry) => void }

function resolve(o: SendPathOptions): Resolved {
	return {
		readUrl: o.readUrl,
		sendUrl: o.sendUrl,
		chainId: o.chainId,
		senders: o.senders,
		budgetMs: o.budgetMs ?? 35_000,
		attemptTimeoutMs: o.attemptTimeoutMs ?? 10_000,
		delayMs: o.delayMs ?? 500,
		visibilityMs: o.visibilityMs ?? 30_000,
		visibilityPollMs: o.visibilityPollMs ?? 2_000,
		rePushes: o.rePushes ?? 4,
		journal: o.journal ?? (() => {}),
	}
}

/** A send path over two endpoints. `send` resolves to the local hash once a send is admitted. */
export class SendPath {
	readonly o: Resolved
	/** Every admitted transaction, by hash; the relay's nonce floor reads it. */
	readonly sent = new Map<Hex, SentTx>()
	/** The one hash each sender's nonce may go out as, from its first attempt on. */
	private readonly claimed = new Map<string, Hex>()
	/** Sends that got a final answer, which the same bytes get again without leaving. */
	private readonly finals = new Map<Hex, SendPathError>()
	private readonly watches = new Map<Hex, Promise<number | undefined>>()
	private closed = false

	constructor(opts: SendPathOptions) {
		this.o = resolve(opts)
	}

	private note(tx: SentTx, endpoint: JournalEntry["endpoint"], event: string): void {
		this.o.journal({ at: new Date().toISOString(), hash: tx.hash, nonce: tx.nonce, endpoint, event: short(event) })
	}

	private async attempt(raw: Hex, tx: SentTx, n: number, timeoutMs: number): Promise<Outcome> {
		const body = JSON.stringify({ jsonrpc: "2.0", id: n, method: "eth_sendRawTransaction", params: [raw] })
		let out: Outcome
		try {
			const { status, text } = await postJson(this.o.sendUrl, body, timeoutMs)
			out = classifySend(status, text, tx.hash)
		} catch (e) {
			out = classifyThrown(e)
		}
		this.note(tx, "send", `attempt ${n}: ${out.kind}${"detail" in out ? ` (${out.detail})` : ""}`)
		return out
	}

	/** True when either endpoint knows `tx`, pending or mined. */
	async known(tx: SentTx): Promise<boolean> {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [tx.hash] })
		for (const [endpoint, url] of [
			["read", this.o.readUrl],
			["send", this.o.sendUrl],
		] as const) {
			try {
				const { status, text } = await postJson(url, body, LOOKUP_TIMEOUT_MS)
				const found = names(status, text, tx.hash)
				this.note(tx, endpoint, found ? "lookup: found" : "lookup: not found")
				if (found) return true
			} catch (e) {
				this.note(tx, endpoint, `lookup: ${classifyThrown(e).kind}`)
			}
		}
		return false
	}

	private admitted(raw: Hex, tx: SentTx): Hex {
		this.sent.set(tx.hash, tx)
		if (!this.watches.has(tx.hash)) this.watches.set(tx.hash, this.watch(raw, tx))
		return tx.hash
	}

	/** What one outcome ends in: the hash, an error, or undefined when the same bytes go again. */
	private async settle(raw: Hex, tx: SentTx, out: Outcome): Promise<Hex | SendPathError | undefined> {
		switch (out.kind) {
			case "admitted":
			case "known":
				return this.admitted(raw, tx)
			case "other-hash":
				return new SendPathError("other-hash", `the send endpoint answered ${out.got} for ${tx.hash}`, tx)
			case "final": {
				if (await this.known(tx)) return this.admitted(raw, tx)
				const final = new SendPathError("final", `${tx.hash} (nonce ${tx.nonce}) was refused: ${out.detail}`, tx, out)
				this.finals.set(tx.hash, final)
				return final
			}
			case "conflict":
				if (await this.known(tx)) return this.admitted(raw, tx)
				return new SendPathError("conflict", `${tx.hash} lost nonce ${tx.nonce} to another transaction`, tx, undefined, out.detail)
			default:
				return undefined
		}
	}

	/** Claims `tx`'s sender and nonce for its hash; another hash at that nonce never leaves. */
	private claim(tx: SentTx): void {
		const key = `${tx.sender.toLowerCase()}:${tx.nonce}`
		const held = this.claimed.get(key)
		if (held !== undefined && held !== tx.hash)
			throw new SendPathError(
				"nonce",
				`refused: ${tx.hash} would reuse nonce ${tx.nonce}; this command already sent ${held} at that nonce and is waiting on it`,
				tx,
			)
		this.claimed.set(key, tx.hash)
	}

	/** One past the highest nonce `sender` was admitted at, if any. */
	nextNonce(sender: string): number | undefined {
		let next: number | undefined
		for (const t of this.sent.values()) if (isAddressEqual(t.sender, sender as Address)) next = Math.max(next ?? 0, t.nonce + 1)
		return next
	}

	/** A head transaction count for one of the senders, raised to {@link nextNonce} when the endpoint answers below it. */
	floorCount(params: unknown, count: unknown): unknown {
		const [who, tag] = Array.isArray(params) ? params : []
		const next = typeof who === "string" && isHead(tag) ? this.nextNonce(who) : undefined
		if (next === undefined || typeof count !== "string" || BigInt(count) >= BigInt(next)) return count
		return `0x${next.toString(16)}`
	}

	/**
	 * Sends `raw` under the rules above and resolves to its local hash once it is admitted.
	 * @throws SendPathError naming the hash and nonce of a send that was not admitted
	 */
	async send(raw: Hex): Promise<Hex> {
		const tx = await checkEnvelope(raw, this.o.chainId, this.o.senders)
		this.claim(tx)
		const final = this.finals.get(tx.hash)
		if (final) throw final
		const deadline = Date.now() + this.o.budgetMs
		// What the last attempt gets of the budget at least; a shorter one could not be answered.
		const reserve = Math.min(1_000, this.o.budgetMs / 10)
		let first: string | undefined
		for (let n = 1; ; n++) {
			if (this.closed) throw new SendPathError("closed", `${tx.hash} (nonce ${tx.nonce}) was not admitted: the send path closed`, tx)
			const out = await this.attempt(raw, tx, n, Math.min(this.o.attemptTimeoutMs, Math.max(1, deadline - Date.now())))
			const end = await this.settle(raw, tx, out)
			if (typeof end === "string") return end
			if (end) throw end
			first ??= "detail" in out ? out.detail : out.kind
			const wait = Math.min(this.o.delayMs * 2 ** (n - 1), 4_000, deadline - Date.now() - reserve)
			if (wait < 0) break
			await sleep(wait)
		}
		if (await this.known(tx)) return this.admitted(raw, tx)
		throw new SendPathError(
			"budget",
			`${tx.hash} (nonce ${tx.nonce}) was not admitted within ${this.o.budgetMs} ms`,
			tx,
			undefined,
			first,
		)
	}

	private async visibleOnRead(tx: SentTx): Promise<boolean> {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [tx.hash] })
		try {
			const { status, text } = await postJson(this.o.readUrl, body, LOOKUP_TIMEOUT_MS)
			return names(status, text, tx.hash)
		} catch {
			return false
		}
	}

	/** Resolves to the ms from admission until the read endpoint showed the hash, or undefined if it never did. */
	private async watch(raw: Hex, tx: SentTx): Promise<number | undefined> {
		const start = Date.now()
		let pushedAt = start
		let pushes = 0
		while (!this.closed) {
			if (await this.visibleOnRead(tx)) {
				this.note(tx, "read", `visible after ${Date.now() - start} ms`)
				return Date.now() - start
			}
			if (this.closed) break
			if (Date.now() - pushedAt >= this.o.visibilityMs) {
				if (pushes === this.o.rePushes) break
				pushes++
				pushedAt = Date.now()
				const out = await this.attempt(raw, tx, 100 + pushes, LOOKUP_TIMEOUT_MS)
				if (!["admitted", "known", "refused", "ambiguous"].includes(out.kind)) {
					this.note(tx, "read", `watch ended: a re-push was answered ${out.kind}`)
					return undefined
				}
			}
			await idle(this.o.visibilityPollMs)
		}
		this.note(tx, "read", this.closed ? "watch closed" : `not visible after ${pushes} re-pushes`)
		return undefined
	}

	/** The ms from admission until the read endpoint showed `hash`, or undefined if it never did or the path closed. */
	visible(hash: Hex): Promise<number | undefined> {
		return this.watches.get(hash) ?? Promise.resolve(undefined)
	}

	/** Ends every visibility watch, and every send still re-sending before its next attempt. */
	close(): void {
		this.closed = true
	}
}

type Args = { method: string; params?: unknown }
type Request = (args: Args, options?: { retryCount?: number }) => Promise<unknown>
type TransportLike = (args: never) => { request: Request }

/**
 * Wraps a viem transport over the read endpoint so its `eth_sendRawTransaction` takes `path` instead, and
 * a sender's head transaction count is never below one past its last admitted send: a lagging backend
 * would otherwise have viem sign the next transaction at a nonce already used. It is generic over the
 * transport's type, so a caller on another viem copy wraps its own.
 */
export function sendThrough<T extends TransportLike>(transport: T, path: SendPath): T {
	return ((args: never) => {
		const t = transport(args)
		const request: Request = (r, o) => {
			if (r.method === "eth_getTransactionCount") return t.request(r, o).then((n) => path.floorCount(r.params, n))
			if (r.method !== "eth_sendRawTransaction") return t.request(r, o)
			const raw = Array.isArray(r.params) ? r.params[0] : undefined
			if (typeof raw !== "string") return Promise.reject(new SendPathError("envelope", "refused: no raw transaction"))
			return path.send(raw as Hex)
		}
		return { ...t, request }
	}) as T
}
