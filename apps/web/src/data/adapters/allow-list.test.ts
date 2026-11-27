import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import { ROOT_RECORD_SLOT, type RootRecord, SIZES_SLOT, serializeAspSnapshot } from "@pp/label-paths"
import { afterEach, describe, expect, test, vi } from "vitest"
import { virtualTimer } from "../../test-utils/timer"
import type { AllowListView } from "../ports"
import { type JobWorker, PROVING_BUDGET_SEC, stackAllowList } from "./allow-list"
import { snapshotJobs } from "./snapshot-jobs"
import type { JobRequest } from "./snapshot-protocol"

const NODE = "http://127.0.0.1:8080"
const BOT = "http://127.0.0.1:9090"
const REGISTRY = `0x${"0a".repeat(32)}` as const
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

const poolLeaves = [11n, 22n].map(aspLeaf)
const poolRoot = buildLeanImt(poolLeaves).root
const recordOf = (sequence: bigint, rootTime = 1_000n): RootRecord => ({
	sequence,
	poolRoot,
	birthRoot: 0n,
	l1Block: 3n,
	rootTime,
	poolSize: 2n,
	birthSize: 0n,
})
const SLOTS = [0n, 1n, 2n, 3n, 4n].map((i) => ROOT_RECORD_SLOT + i).concat([SIZES_SLOT, SIZES_SLOT + 1n])
const body = (sequence: bigint, declared = poolRoot) =>
	JSON.stringify({
		...JSON.parse(serializeAspSnapshot({ sequence, poolRoot, birthRoot: 0n, poolLeaves, birthLeaves: [] })),
		poolRoot: String(declared),
	})

/**
 * A node that answers `latest` with `tip`, block data and storage by hash, and a bot that serves
 * `snapshots`; every request is logged.
 */
function chain() {
	const blocks = new Map<string, { timestamp: number; record: RootRecord }>()
	const snapshots = new Map<bigint, string>()
	const s = {
		tip: "",
		blocks,
		snapshots,
		holdBot: false,
		rpc: [] as { method: string; params: unknown[] }[],
		bot: [] as string[],
		/** Runs once, right after a block-data answer: a new block can land between the two reads. */
		afterBlockData: null as (() => void) | null,
	}
	const field = (v: bigint) => `0x${v.toString(16)}`
	const fetchFn = (async (url: string, init?: RequestInit) => {
		if (url.startsWith(BOT)) {
			s.bot.push(url.slice(BOT.length))
			if (s.holdBot) return new Promise<Response>(() => {})
			const text = snapshots.get(BigInt(url.split("/").at(-1) as string))
			return text === undefined ? new Response(null, { status: 404 }) : new Response(text)
		}
		const { method, params } = JSON.parse(init?.body as string) as { method: string; params: unknown[] }
		s.rpc.push({ method, params })
		const at = (p: unknown) => (p === "latest" ? s.tip : (p as { hash: string }).hash)
		if (method === "node_getBlockData") {
			const h = at(params[0])
			const b = blocks.get(h)
			const answer = Response.json({ result: b ? { blockHash: h, header: { globalVariables: { timestamp: b.timestamp } } } : null })
			const next = s.afterBlockData
			s.afterBlockData = null
			next?.()
			return answer
		}
		const r = blocks.get(at(params[0]))?.record as RootRecord
		const values = [r.sequence, r.poolRoot, r.birthRoot, r.l1Block, r.rootTime, r.poolSize, r.birthSize]
		return Response.json({ result: field(values[SLOTS.indexOf(BigInt(params[2] as string))] as bigint) })
	}) as typeof fetch
	const post = (n: number, timestamp: number, record: RootRecord) => {
		blocks.set(hash(n), { timestamp, record })
		s.tip = hash(n)
	}
	return { s, fetchFn, post }
}

/** In-process workers over the real job code; `hold` keeps every check unanswered. */
function workers(o: { hold?: boolean } = {}) {
	const made: { requests: JobRequest[]; terminated: boolean; crash(): void }[] = []
	const factory = (): JobWorker => {
		let crash = () => {}
		const log = { requests: [] as JobRequest[], terminated: false, crash: () => crash() }
		made.push(log)
		let reply: Parameters<JobWorker["onReply"]>[0] = () => {}
		const jobs = snapshotJobs((r) => reply(r))
		return {
			post(req) {
				log.requests.push(req)
				if (!(o.hold && req.kind === "check")) queueMicrotask(() => jobs.handle(req))
			},
			onReply(f) {
				reply = f
			},
			onError(f) {
				crash = f
			},
			terminate() {
				log.terminated = true
			},
		}
	}
	return { made, factory, loads: () => made.flatMap((w) => w.requests).filter((r) => r.kind === "load").length }
}

function rig(o: { hold?: boolean } = {}) {
	const c = chain()
	const w = workers(o)
	const timer = virtualTimer()
	vi.stubGlobal("fetch", c.fetchFn)
	const port = stackAllowList({ nodeUrl: NODE, registry: REGISTRY, botUrl: BOT, timer, worker: w.factory, fetch: c.fetchFn })
	return { ...c, w, timer, port }
}

afterEach(() => void vi.unstubAllGlobals())

describe("the stack's allow list", () => {
	test("reads the record and its time at one block hash, and fetches the snapshot that record names", async () => {
		const r = rig()
		r.post(40, 1_500, recordOf(7n))
		r.s.snapshots.set(7n, body(7n))
		// Block 41 lands between the time read and the record read: only a read pinned to 40 still sees 7.
		r.s.afterBlockData = () => r.post(41, 1_600, recordOf(8n))
		const view = await r.port.current()
		expect(view).toEqual({ record: recordOf(7n), nowSec: 1_500n })
		const storage = r.s.rpc.filter((q) => q.method === "node_getPublicStorageAt")
		expect(storage).toHaveLength(7)
		for (const q of storage) expect(q.params[0]).toEqual({ hash: hash(40) })
		await expect(r.port.check(view, 11n, 0)).resolves.toMatchObject({ state: "ACTIVE" })
		expect(r.s.bot).toEqual(["/v1/snapshots/7"])
		const check = r.w.made[0]?.requests.find((q) => q.kind === "check")
		expect(check).toMatchObject({ nowSec: 1_500n + PROVING_BUDGET_SEC })
	})

	test("the same roots under a new sequence cost no download and no load", async () => {
		const r = rig()
		r.s.snapshots.set(7n, body(7n))
		await r.port.check({ record: recordOf(7n), nowSec: 1_100n }, 11n, 0)
		const heartbeat: AllowListView = { record: recordOf(8n, 1_300n), nowSec: 1_400n }
		await expect(r.port.check(heartbeat, 22n, 0)).resolves.toMatchObject({ state: "ACTIVE" })
		await expect(r.port.check(heartbeat, 33n, 0)).resolves.toEqual({ state: "ABSENT" })
		expect([r.s.bot, r.w.loads(), r.w.made.length]).toEqual([["/v1/snapshots/7"], 1, 1])
	})

	test("after a 404 reads the latest record and retries once, with its sequence", async () => {
		const r = rig()
		r.post(41, 1_500, recordOf(9n, 1_400n))
		r.s.snapshots.set(9n, body(9n))
		const view = { record: recordOf(7n), nowSec: 1_100n }
		await expect(r.port.check(view, 11n, 0)).resolves.toMatchObject({ state: "ACTIVE" })
		expect(r.s.bot).toEqual(["/v1/snapshots/7", "/v1/snapshots/9"])
		r.s.snapshots.clear()
		r.port.cancel()
		r.port.checkAgain(view)
		await expect(r.port.check(view, 11n, 0)).rejects.toMatchObject({ code: "LIST_UNAVAILABLE" })
		expect(r.s.bot.slice(2)).toEqual(["/v1/snapshots/7", "/v1/snapshots/9"])
	})

	test("a list that does not match the chain is not fetched again until a Check again, which backs off", async () => {
		const r = rig()
		r.s.snapshots.set(7n, body(7n, poolRoot + 1n))
		const view = { record: recordOf(7n), nowSec: 1_100n }
		await expect(r.port.check(view, 11n, 0)).rejects.toMatchObject({ code: "LIST_MISMATCH", retryInMs: 5_000 })
		await expect(r.port.check({ ...view, nowSec: 1_200n }, 11n, 0)).rejects.toMatchObject({ code: "LIST_MISMATCH" })
		expect(r.s.bot).toHaveLength(1)
		expect(r.port.checkAgain(view)).toBe(false)
		r.timer.advance(5_000)
		expect(r.port.checkAgain(view)).toBe(true)
		await expect(r.port.check(view, 11n, 0)).rejects.toMatchObject({ code: "LIST_MISMATCH", retryInMs: 10_000 })
		expect(r.s.bot).toHaveLength(2)
	})

	test("a list refused for its length holds only that record's lists: a record with the same roots and the list's length checks at once", async () => {
		const r = rig()
		r.s.snapshots.set(7n, body(7n))
		r.s.snapshots.set(8n, body(8n))
		const wrong = { record: { ...recordOf(7n), poolSize: 3n }, nowSec: 1_100n }
		await expect(r.port.check(wrong, 11n, 0)).rejects.toMatchObject({ code: "LIST_MISMATCH" })
		const corrected = { record: recordOf(8n, 1_300n), nowSec: 1_400n }
		await expect(r.port.check(corrected, 11n, 0)).resolves.toMatchObject({ state: "ACTIVE" })
		expect(r.s.bot).toEqual(["/v1/snapshots/7", "/v1/snapshots/8"])
	})

	test("a list that declares the record's roots but whose leaves build another never answers absent", async () => {
		const r = rig()
		const whole = JSON.parse(body(7n)) as { poolLeaves: string[] }
		r.s.snapshots.set(7n, JSON.stringify({ ...whole, poolLeaves: whole.poolLeaves.slice(0, 1) }))
		await expect(r.port.check({ record: recordOf(7n), nowSec: 1_100n }, 22n, 0)).rejects.toMatchObject({ code: "LIST_MISMATCH" })
	})

	test("Cancel ends the worker and the running check; the stopped list waits for a Check again", async () => {
		const r = rig({ hold: true })
		r.s.snapshots.set(7n, body(7n))
		const view = { record: recordOf(7n), nowSec: 1_100n }
		const held = r.port.check(view, 11n, 0)
		const queued = r.port.check(view, 22n, 0)
		await vi.waitFor(() => expect(r.w.made[0]?.requests.some((q) => q.kind === "check")).toBe(true))
		r.port.cancel()
		await expect(held).rejects.toMatchObject({ code: "LIST_CANCELLED" })
		await expect(queued).rejects.toMatchObject({ code: "LIST_CANCELLED" })
		expect(r.w.made[0]?.terminated).toBe(true)
		await expect(r.port.check(view, 11n, 0)).rejects.toMatchObject({ code: "LIST_CANCELLED", retryInMs: 0 })
		expect(r.s.bot).toHaveLength(1)
		expect(r.port.checkAgain(view)).toBe(true)
		void r.port.check(view, 11n, 0).catch(() => {})
		await vi.waitFor(() => expect(r.w.made).toHaveLength(2))
		expect(r.s.bot).toHaveLength(2)
	})

	test("a worker that dies fails its check as unavailable, frees the queue behind it, and the next check starts a new one", async () => {
		const r = rig({ hold: true })
		r.s.snapshots.set(7n, body(7n))
		const view = { record: recordOf(7n), nowSec: 1_100n }
		const progress: unknown[] = []
		r.port.onProgress((p) => progress.push(p))
		const held = r.port.check(view, 11n, 0)
		const queued = r.port.check(view, 22n, 0)
		await vi.waitFor(() => expect(progress[0]).toEqual({ hashed: 0, total: 0 }))
		await vi.waitFor(() => expect(r.w.made[0]?.requests.some((q) => q.kind === "check")).toBe(true))
		r.w.made[0]?.crash()
		await expect(held).rejects.toMatchObject({ code: "LIST_UNAVAILABLE" })
		expect(r.w.made[0]?.terminated).toBe(true)
		await vi.waitFor(() => expect(r.w.made).toHaveLength(2))
		r.w.made[1]?.crash()
		await expect(queued).rejects.toMatchObject({ code: "LIST_UNAVAILABLE" })
	})

	test("Cancel also ends a download still under way", async () => {
		const r = rig()
		r.s.holdBot = true
		const downloading = r.port.check({ record: recordOf(7n), nowSec: 1_100n }, 11n, 0)
		await vi.waitFor(() => expect(r.s.bot).toHaveLength(1))
		r.port.cancel()
		await expect(downloading).rejects.toMatchObject({ code: "LIST_CANCELLED" })
		expect(r.w.made).toEqual([])
	})
})
