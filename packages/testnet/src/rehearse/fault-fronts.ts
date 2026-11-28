/**
 * A read front and a send front for one anvil that fail the way a public gateway does, so a rehearsal runs
 * the real CLIs through the send path and sees each fault fire. Each fault is armed for one nonce of
 * `sender`; every other call is forwarded as it came.
 *
 * - `refuse`: a send at that nonce answers HTTP 429, `times` times, before one is forwarded.
 * - `loseAnswer`: the first send at that nonce reaches anvil with mining paused and its answer is replaced
 *   by HTTP 504, so the same bytes sent again meet "transaction already imported"; mining resumes then.
 * - `stale`, each entry for its own nonce: once the send at that nonce is forwarded, its receipt reads null
 *   for `receiptMs`; for `nonceMs` the sender's count reads as it was before that send, and with
 *   `revertEstimate` the first gas estimate in that time reverts. Of two entries in their window, the
 *   later nonce answers.
 * - `readError`: the first receipt read of the send at that nonce answers HTTP 503.
 */
import { claimPort, releaseNamed } from "@pp/run-isolation/ports"
import {
	type Address,
	type Hex,
	isAddressEqual,
	keccak256,
	numberToHex,
	parseTransaction,
	recoverTransactionAddress,
	type TransactionSerialized,
} from "viem"
import { type LoopbackServer, type Reply, serveHttp } from "./loopback"

export type StaleFault = { nonce: number; receiptMs: number; nonceMs: number; revertEstimate?: boolean }

export type Faults = {
	sender: Address
	refuse?: { nonce: number; times: number }
	loseAnswer?: number
	stale?: readonly StaleFault[]
	readError?: number
}

/** How often each fault fired since the last {@link FaultFronts.arm}, and every hash the send front refused. */
export type Fired = {
	refused: number
	lost: number
	alreadyImported: number
	nullReceipts: number
	staleCounts: number
	/** Stale counts answered, by the nonce of the entry that answered them. */
	staleCountsAt: Record<number, number>
	revertedEstimates: number
	readErrors: number
	refusedHashes: Hex[]
	/** Every distinct raw transaction of the armed sender the send front received, refused or not. */
	raws: Hex[]
	/** From the first refusal to the last, in ms. */
	refusedSpanMs: number
}

export type FaultFronts = {
	read: LoopbackServer
	send: LoopbackServer
	/** Replaces the armed faults, or disarms them, and zeroes {@link fired}. */
	arm(faults: Faults | undefined): void
	fired(): Fired
	close(): Promise<void>
}

type Call = { id?: unknown; method?: string; params?: unknown[] }

/** A lost answer's paused mining resumes by then even if the same bytes never come again. */
const RESUME_MINING_MS = 15_000

const zero = (): Fired => ({
	refused: 0,
	lost: 0,
	alreadyImported: 0,
	nullReceipts: 0,
	staleCounts: 0,
	staleCountsAt: {},
	revertedEstimates: 0,
	readErrors: 0,
	refusedHashes: [],
	raws: [],
	refusedSpanMs: 0,
})
const status = (code: number, text: string): Reply => ({ status: code, body: text })
const answer = (call: Call, fields: object): Reply => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: call.id, ...fields }) })
const single = (body: string): Call | undefined => {
	try {
		const v = JSON.parse(body) as unknown
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Call) : undefined
	} catch {
		return undefined
	}
}

class Fronts {
	private readonly upstream: string
	private faults: Faults | undefined
	fired = zero()
	/** When, and as which hash, the first send at each nonce of the sender was forwarded. */
	private readonly forwarded = new Map<number, { hash: Hex; at: number }>()
	private readonly refusals = new Map<number, number>()
	private readonly spent = new Set<string>()
	private firstRefusalAt = 0
	private paused: ReturnType<typeof setTimeout> | undefined

	constructor(upstream: string) {
		this.upstream = upstream
	}

	arm(faults: Faults | undefined): void {
		this.faults = faults
		this.fired = zero()
		this.forwarded.clear()
		this.refusals.clear()
		this.spent.clear()
		this.firstRefusalAt = 0
	}

	private once(what: string): boolean {
		if (this.spent.has(what)) return false
		this.spent.add(what)
		return true
	}

	private async forward(body: string): Promise<Reply> {
		const res = await fetch(this.upstream, { method: "POST", headers: { "content-type": "application/json" }, body })
		return { status: res.status, body: await res.text() }
	}

	private rpc = (method: string, params: unknown[] = []) => this.forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))

	async resume(): Promise<void> {
		if (this.paused === undefined) return
		clearTimeout(this.paused)
		this.paused = undefined
		await this.rpc("evm_setAutomine", [true])
		await this.rpc("evm_mine")
	}

	async send(body: string): Promise<Reply> {
		const call = single(body)
		const f = this.faults
		if (!f || call?.method !== "eth_sendRawTransaction") return this.forward(body)
		const raw = call.params?.[0] as TransactionSerialized
		if (!isAddressEqual(await recoverTransactionAddress({ serializedTransaction: raw }), f.sender)) return this.forward(body)
		if (!this.fired.raws.includes(raw)) this.fired.raws.push(raw)
		const nonce = parseTransaction(raw).nonce as number
		const hash = keccak256(raw)
		const refused = this.refusals.get(nonce) ?? 0
		if (f.refuse?.nonce === nonce && refused < f.refuse.times) {
			this.refusals.set(nonce, refused + 1)
			this.fired.refused++
			this.firstRefusalAt ||= Date.now()
			this.fired.refusedSpanMs = Date.now() - this.firstRefusalAt
			if (!this.fired.refusedHashes.includes(hash)) this.fired.refusedHashes.push(hash)
			return status(429, "Too Many Requests")
		}
		const first = !this.forwarded.has(nonce)
		if (f.loseAnswer === nonce && first) {
			await this.rpc("evm_setAutomine", [false])
			this.paused = setTimeout(() => void this.resume(), RESUME_MINING_MS)
		}
		const r = await this.forward(body)
		if (first) this.forwarded.set(nonce, { hash, at: Date.now() })
		if (f.loseAnswer !== nonce) return r
		if (first) {
			this.fired.lost++
			return status(504, "Gateway Timeout")
		}
		if (r.body.includes("already imported")) this.fired.alreadyImported++
		await this.resume()
		return r
	}

	async read(body: string): Promise<Reply> {
		const call = single(body)
		const f = this.faults
		if (!f || !call) return this.forward(body)
		// The newest send's stale view answers first: a later send supersedes an earlier one's.
		for (const s of [...(f.stale ?? [])].sort((a, b) => b.nonce - a.nonce)) {
			const r = this.stale(call, f.sender, s)
			if (r) return r
		}
		return this.readError(call, f) ?? this.forward(body)
	}

	private stale(call: Call, sender: Address, s: StaleFault): Reply | undefined {
		const sent = this.forwarded.get(s.nonce)
		if (!sent) return undefined
		const age = Date.now() - sent.at
		const [first] = call.params ?? []
		if (call.method === "eth_getTransactionReceipt" && first === sent.hash && age < s.receiptMs) {
			this.fired.nullReceipts++
			return answer(call, { result: null })
		}
		if (age >= s.nonceMs) return undefined
		if (call.method === "eth_getTransactionCount" && typeof first === "string" && isAddressEqual(first as Address, sender)) {
			this.fired.staleCounts++
			this.fired.staleCountsAt[s.nonce] = (this.fired.staleCountsAt[s.nonce] ?? 0) + 1
			return answer(call, { result: numberToHex(s.nonce) })
		}
		if (s.revertEstimate && call.method === "eth_estimateGas" && this.once(`estimate ${s.nonce}`)) {
			this.fired.revertedEstimates++
			return answer(call, { error: { code: 3, message: "execution reverted", data: "0x" } })
		}
		return undefined
	}

	private readError(call: Call, f: Faults): Reply | undefined {
		const sent = f.readError === undefined ? undefined : this.forwarded.get(f.readError)
		if (!sent || call.method !== "eth_getTransactionReceipt" || call.params?.[0] !== sent.hash || !this.once("read")) return undefined
		this.fired.readErrors++
		return status(503, "Service Unavailable")
	}
}

/** Both fronts over `upstream`, each on a port claimed for `owner`. */
export async function startFaultFronts(upstream: string, owner: string): Promise<FaultFronts> {
	const fronts = new Fronts(upstream)
	const readPort = await claimPort(owner, "fault-read")
	const sendPort = await claimPort(owner, "fault-send")
	const read = await serveHttp(readPort, (b) => fronts.read(b))
	const send = await serveHttp(sendPort, (b) => fronts.send(b))
	return {
		read,
		send,
		arm: (f) => fronts.arm(f),
		fired: () => fronts.fired,
		close: async () => {
			await fronts.resume()
			await Promise.all([read.close(), send.close()])
			await releaseNamed([
				{ port: readPort, service: "fault-read", owner },
				{ port: sendPort, service: "fault-send", owner },
			])
		},
	}
}
