/**
 * The send rules every keyed L1 send follows, whether forge's (through the loopback relay) or a viem
 * wallet's: `eth_sendRawTransaction` goes to the send endpoint, every other call to the read endpoint.
 *
 * Before a send leaves, its envelope is decoded: the chain id must be the expected one and the recovered
 * sender one of the expected addresses. Only the bytes received are forwarded, and its hash is computed
 * here. Each answer is classified:
 *
 * - the local hash: admitted. Another hash: refused at once.
 * - "already known": admitted, since a hash commits to the exact signed bytes.
 * - "nonce too low" or "replacement underpriced": admitted if either endpoint knows the local hash; else a
 *   conflict, reported with the hash and nonce.
 * - refused (HTTP 429 or 503, JSON-RPC -32005 or 429, a connection refused before the write) and ambiguous
 *   (a timeout, a reset, HTTP 500, 502 or 504, an unreadable body): the same bytes go again, inside one
 *   budget shorter than forge's 45 s request timeout. When the budget ends, either endpoint knowing the
 *   hash makes it admitted; else it fails, with the hash and nonce.
 * - anything else (insufficient funds, intrinsic gas, a refused gas limit, a bad signature or chain id,
 *   invalid params): final, passed through at once.
 *
 * After an admission the read endpoint must show the hash within `visibilityMs`; each time it does not,
 * the same bytes go to the send endpoint again. Every attempt and answer goes to `journal`. Both
 * endpoints are fetched with redirects refused.
 */
import { appendFileSync } from "node:fs"
import { type Address, type Hex, isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress } from "viem"

const KNOWN = /already known|alreadyknown|known transaction|already imported/i
const CONFLICT = /nonce too low|oldnonce|replacement (?:transaction )?underpriced/i
const REFUSED_CODES = new Set([-32005, 429])
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

/** A journal that appends each entry as a JSON line to `path`, readable by this user only. */
export const journalTo =
	(path: string) =>
	(entry: JournalEntry): void =>
		appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })

export type SentTx = { hash: Hex; nonce: number; sender: Address }

export type SendPathErrorKind = "envelope" | "final" | "other-hash" | "conflict" | "budget"

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

function classifyError(status: number, text: string, error: NonNullable<Answer["error"]>): Outcome {
	const message = String(error.message ?? "")
	const detail = `${error.code} ${message}`
	if (KNOWN.test(message)) return { kind: "known" }
	if (CONFLICT.test(message)) return { kind: "conflict", detail }
	if (REFUSED_CODES.has(Number(error.code))) return { kind: "refused", detail }
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
 * @throws SendPathError (`envelope`) for undecodable bytes, another or no chain id, or another sender
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
	private readonly watches = new Map<Hex, Promise<number | undefined>>()
	private closed = false

	constructor(opts: SendPathOptions) {
		this.o = resolve(opts)
	}

	private note(tx: SentTx, endpoint: JournalEntry["endpoint"], event: string): void {
		this.o.journal({ at: new Date().toISOString(), hash: tx.hash, nonce: tx.nonce, endpoint, event })
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
				const r = parseAnswer((await postJson(url, body, LOOKUP_TIMEOUT_MS)).text)
				const found = r?.result !== null && typeof r?.result === "object"
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
			case "final":
				return new SendPathError("final", `${tx.hash} (nonce ${tx.nonce}) was refused: ${out.detail}`, tx, out)
			case "conflict":
				if (await this.known(tx)) return this.admitted(raw, tx)
				return new SendPathError("conflict", `${tx.hash} lost nonce ${tx.nonce} to another transaction`, tx, undefined, out.detail)
			default:
				return undefined
		}
	}

	/**
	 * Sends `raw` under the rules above and resolves to its local hash once it is admitted.
	 * @throws SendPathError naming the hash and nonce of a send that was not admitted
	 */
	async send(raw: Hex): Promise<Hex> {
		const tx = await checkEnvelope(raw, this.o.chainId, this.o.senders)
		const deadline = Date.now() + this.o.budgetMs
		let first: string | undefined
		for (let n = 1; ; n++) {
			const out = await this.attempt(raw, tx, n, Math.min(this.o.attemptTimeoutMs, Math.max(1, deadline - Date.now())))
			const end = await this.settle(raw, tx, out)
			if (typeof end === "string") return end
			if (end) throw end
			first ??= "detail" in out ? out.detail : out.kind
			const wait = Math.min(this.o.delayMs * 2 ** (n - 1), 4_000)
			if (Date.now() + wait >= deadline) break
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
			const r = parseAnswer((await postJson(this.o.readUrl, body, LOOKUP_TIMEOUT_MS)).text)
			return r?.result !== null && typeof r?.result === "object"
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
			if (Date.now() - pushedAt >= this.o.visibilityMs) {
				if (pushes === this.o.rePushes) break
				pushes++
				pushedAt = Date.now()
				await this.attempt(raw, tx, 100 + pushes, LOOKUP_TIMEOUT_MS)
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

	/** Ends every visibility watch. */
	close(): void {
		this.closed = true
	}
}

type Args = { method: string; params?: unknown }
type Request = (args: Args, options?: { retryCount?: number }) => Promise<unknown>
type TransportLike = (args: never) => { request: Request }

/**
 * Wraps a viem transport over the read endpoint so its `eth_sendRawTransaction` takes `path` instead.
 * It is generic over the transport's type, so a caller on another viem copy wraps its own.
 */
export function sendThrough<T extends TransportLike>(transport: T, path: SendPath): T {
	return ((args: never) => {
		const t = transport(args)
		const request: Request = (r, o) => {
			if (r.method !== "eth_sendRawTransaction") return t.request(r, o)
			const raw = Array.isArray(r.params) ? r.params[0] : undefined
			if (typeof raw !== "string") return Promise.reject(new SendPathError("envelope", "refused: no raw transaction"))
			return path.send(raw as Hex)
		}
		return { ...t, request }
	}) as T
}
