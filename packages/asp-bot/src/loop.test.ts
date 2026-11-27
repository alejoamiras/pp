import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import { parseAspSnapshot, type RootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import type { L1Block, PostArgs } from "./decide"
import { type Ports, Poster } from "./loop"
import { respond, SnapshotBook } from "./server"

const SELF = 0xb07n
const set1 = [1n, 2n].map(aspLeaf)
const set2 = [1n, 2n, 3n].map(aspLeaf)
const root = (l: bigint[]) => buildLeanImt(l).root

function chain() {
	const s = {
		record: { sequence: 0n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n } as RootRecord,
		aztecTime: 1_000n,
		l1: { number: 10n, hash: "0x0a", timestamp: 900n } as L1Block,
		chainRoot: root(set1),
		aspLeaves: set1,
		poster: SELF,
		fetches: 0,
		logs: [] as string[],
	}
	const ports: Ports = {
		tip: async () => ({ number: 1, hash: "0x01", time: s.aztecTime }),
		record: async () => s.record,
		poster: async () => s.poster,
		selectL1: async () => s.l1,
		aspRootAt: async () => s.chainRoot,
		aspLeaves: async () => {
			s.fetches++
			return s.aspLeaves
		},
		birthLeaves: async () => [],
		// The registry's rule: a post must take the sequence after the record it lands on.
		post: async (a: PostArgs) => {
			if (a.sequence !== s.record.sequence + 1n) throw new Error("sequence not next")
			s.record = { ...a }
			return { inclusionTime: s.aztecTime + 72n }
		},
		log: (event) => s.logs.push(event),
	}
	/** `set_poster(next)`: the poster and the cleared record, at the next sequence, in one step. */
	const reset = (next = s.poster) => {
		s.record = { sequence: s.record.sequence + 1n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
		s.poster = next
	}
	return { s, ports, reset }
}

describe("a tick", () => {
	it("posts only leaves that hash to the chain's root, keeps them in memory, and serves what it posted", async () => {
		const { s, ports, reset } = chain()
		const book = new SnapshotBook()
		const bot = new Poster(ports, book, { self: SELF, inclusionMarginSec: 144n })

		expect((await bot.tick()).post).toBe(true)
		expect(s.record).toMatchObject({ sequence: 1n, poolRoot: root(set1), l1Block: 10n, rootTime: 900n })
		expect(parseAspSnapshot(JSON.parse(book.body("latest")!)).poolLeaves).toEqual(set1)

		expect(await bot.tick()).toEqual({ post: false, reason: "unchanged" })
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		expect((await bot.tick()).post).toBe(true)
		expect(s.fetches).toBe(1)

		// Ethereum moved to a root whose leaves the ASP no longer serves: nothing is sent.
		s.chainRoot = root(set2)
		expect(await bot.tick()).toEqual({ post: false, reason: "asp_root_mismatch" })
		s.aspLeaves = set2
		expect((await bot.tick()).post).toBe(true)
		expect(book.body(3n)).toBeDefined()

		// A fresh process serves the record it finds current once the ASP's leaves rebuild its root.
		const fresh = new SnapshotBook()
		expect(await new Poster(ports, fresh, { self: SELF, inclusionMarginSec: 144n }).tick()).toEqual({
			post: false,
			reason: "unchanged",
		})
		expect(parseAspSnapshot(JSON.parse(fresh.body("latest")!)).sequence).toBe(3n)

		// `set_poster` clears the record; the old poster must stop serving `/latest` at once.
		reset(0xdeadn)
		expect(await bot.tick()).toEqual({ post: false, reason: "not_poster" })
		expect(book.body("latest")).toBeUndefined()
		ports.selectL1 = async () => {
			throw new Error("anvil down")
		}
		reset(SELF)
		expect(await bot.tick()).toEqual({ post: false, reason: "error" })
		expect(s.logs).toEqual(["posted", "posted", "asp_root_mismatch", "posted", "not_poster", "tick_failed"])
	})

	it("halts, serving nothing, when a posted root comes with a list of another length, until the feed is fixed", async () => {
		const { s, ports } = chain()
		expect((await new Poster(ports, new SnapshotBook(), { self: SELF, inclusionMarginSec: 144n }).tick()).post).toBe(true)
		expect(s.record).toMatchObject({ poolRoot: root(set1), poolSize: 2n, birthSize: 0n })
		const fields: Record<string, unknown>[] = []
		ports.log = (event, f) => {
			s.logs.push(event)
			fields.push(f ?? {})
		}
		// After a restart the feed serves the root itself as the whole list: it builds to the same root.
		s.aspLeaves = [root(set1)]
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		const book = new SnapshotBook()
		const bot = new Poster(ports, book, { self: SELF, inclusionMarginSec: 144n })
		expect(await bot.tick(true)).toEqual({ post: false, reason: "size_mismatch" })
		expect(s.record.sequence).toBe(1n)
		expect(book.body("latest")).toBeUndefined()
		expect(fields.at(-1)).toMatchObject({ list: "pool", root: root(set1), postedSize: 2n, size: 1 })
		expect(fields.at(-1)?.next).toContain("set_poster")
		// The repaired feed is fetched again on the next tick, with no restart.
		s.aspLeaves = set1
		const fetches = s.fetches
		expect((await bot.tick()).post).toBe(true)
		expect(s.fetches).toBe(fetches + 1)
		expect(parseAspSnapshot(JSON.parse(book.body("latest")!)).poolLeaves).toEqual(set1)

		// The birth list is held to its posted length too.
		const births = [7n, 9n].map(aspLeaf)
		ports.birthLeaves = async () => [...births]
		s.aztecTime += 300n
		expect((await bot.tick()).post).toBe(true)
		expect(s.record.birthSize).toBe(2n)
		s.record = { ...s.record, birthSize: 3n }
		expect(await bot.tick()).toEqual({ post: false, reason: "size_mismatch" })
		expect(fields.at(-1)).toMatchObject({ list: "birth", postedSize: 3n, size: 2 })
	})

	it("fetches the feed again after a reset instead of reposting a list it cached before", async () => {
		const { s, ports, reset } = chain()
		// The feed lied when the bot posted: the root itself as the whole list.
		s.aspLeaves = [root(set1)]
		const bot = new Poster(ports, new SnapshotBook(), { self: SELF, inclusionMarginSec: 144n })
		expect((await bot.tick()).post).toBe(true)
		expect(s.record.poolSize).toBe(1n)
		// The feed is fixed, then the admin's set_poster clears the record.
		s.aspLeaves = set1
		reset()
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		expect((await bot.tick()).post).toBe(true)
		expect(s.record).toMatchObject({ sequence: 3n, poolRoot: root(set1), poolSize: 2n })
		expect(s.fetches).toBe(2)
	})

	it("fetches again after a reset that follows a post which landed but whose send failed, and keeps that post's body", async () => {
		const { s, ports, reset } = chain()
		s.aspLeaves = [root(set1)]
		const book = new SnapshotBook()
		const bot = new Poster(ports, book, { self: SELF, inclusionMarginSec: 144n })
		const post = ports.post
		ports.post = async (a) => {
			await post(a)
			throw new Error("no inclusion block")
		}
		expect(await bot.tick()).toEqual({ post: false, reason: "error" })
		expect(s.record).toMatchObject({ sequence: 1n, poolSize: 1n })
		ports.post = post
		// The feed is fixed, and the admin resets the record that post left before the bot reads it again.
		s.aspLeaves = set1
		reset()
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		expect((await bot.tick()).post).toBe(true)
		expect([s.record.sequence, s.record.poolSize, s.fetches]).toEqual([3n, 2n, 2])
		expect(parseAspSnapshot(JSON.parse(book.body(1n)!)).poolLeaves).toEqual([root(set1)])
	})

	it("stops serving a post that lost to a reset, and posts the sequence after the clear", async () => {
		const { s, ports, reset } = chain()
		const errors: unknown[] = []
		ports.log = (event, f) => {
			s.logs.push(event)
			if (event === "tick_failed") errors.push(f?.error)
		}
		let t = 0
		const book = new SnapshotBook()
		const bot = new Poster(ports, book, { self: SELF, inclusionMarginSec: 144n, leavesFloorMs: 300_000, now: () => t })
		expect((await bot.tick()).post).toBe(true)
		// A new root, and the admin re-sets the same poster while the bot's post of 2 is in flight.
		s.chainRoot = root(set2)
		s.aspLeaves = set2
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		const send = ports.post
		ports.post = async (a) => {
			reset()
			return send(a)
		}
		t = 300_000
		expect(await bot.tick()).toEqual({ post: false, reason: "error" })
		expect([errors, s.record.sequence, s.record.poolRoot]).toEqual([["sequence not next"], 2n, 0n])
		const status = (n: string) => respond("GET", `/v1/snapshots/${n}`, book).status
		// Until the bot reads the clear, it still holds the body its fenced post would have named.
		expect(status("2")).toBe(200)
		ports.post = send
		// Inside the floor, so no recovery post hides what reading the clear leaves served.
		t = 300_030
		expect(await bot.tick()).toEqual({ post: false, reason: "asp_deferred" })
		expect(["latest", "2", "1"].map(status)).toEqual([404, 404, 200])
		t = 600_000
		expect((await bot.tick()).post).toBe(true)
		expect([s.record.sequence, s.record.poolRoot, s.fetches]).toEqual([3n, root(set2), 3])
		expect(parseAspSnapshot(JSON.parse(book.body("latest")!)).sequence).toBe(3n)
	})

	it("asks the feed at most once per floor, failures included, and never starves the post a reset waits for", async () => {
		const { s, ports, reset } = chain()
		const fields: Record<string, unknown>[] = []
		ports.log = (event, f) => {
			s.logs.push(event)
			fields.push(f ?? {})
		}
		let t = 0
		const book = new SnapshotBook()
		const bot = new Poster(ports, book, { self: SELF, inclusionMarginSec: 144n, leavesFloorMs: 300_000, now: () => t })
		const at = async (ms: number) => {
			t = ms
			return bot.tick()
		}
		const step = (n: bigint) => {
			s.aztecTime += 300n
			s.l1 = { number: s.l1.number + n, hash: `0x${(s.l1.number + n).toString(16)}`, timestamp: s.aztecTime - 100n }
		}
		expect((await at(0)).post).toBe(true)
		const latest = book.body("latest")

		// A new root inside the floor waits; a mismatch waits a whole floor more; neither posts nor moves /latest.
		s.chainRoot = root(set2)
		step(1n)
		expect(await at(1)).toEqual({ post: false, reason: "asp_deferred" })
		expect(await at(300_000)).toEqual({ post: false, reason: "asp_root_mismatch" })
		expect(fields.at(-1)).toMatchObject({ chainRoot: root(set2), aspRoot: root(set1) })
		expect(fields.at(-1)?.why).toContain("do not hash")
		expect(fields.at(-1)?.next).toContain("request floor")
		for (const ms of [300_001, 599_999]) expect(await at(ms)).toEqual({ post: false, reason: "asp_deferred" })
		expect([s.fetches, s.record.sequence, book.body("latest")]).toEqual([2, 1n, latest])
		s.aspLeaves = set2
		expect((await at(600_000)).post).toBe(true)

		// A fetch that fails uses the allowance too.
		const aspLeaves = ports.aspLeaves
		ports.aspLeaves = async () => {
			s.fetches++
			throw new Error("HTTP 503")
		}
		s.chainRoot = root(set1)
		step(1n)
		expect(await at(900_000)).toEqual({ post: false, reason: "error" })
		expect(await at(900_001)).toEqual({ post: false, reason: "asp_deferred" })
		ports.aspLeaves = aspLeaves
		s.aspLeaves = set1
		expect((await at(1_200_000)).post).toBe(true)
		expect(s.fetches).toBe(5)

		// A reset is fetched again once; when its post fails, a retry at the same clear reuses that list.
		reset()
		step(1n)
		const post = ports.post
		const attempts: bigint[] = []
		ports.post = async (a) => {
			attempts.push(a.sequence)
			throw new Error("send failed")
		}
		expect(await at(1_500_000)).toEqual({ post: false, reason: "error" })
		expect(await at(1_500_030)).toEqual({ post: false, reason: "error" })
		expect([attempts, s.fetches]).toEqual([[5n, 5n], 6])
		// A second reset with no post between drops the list fetched since the first, within the floor.
		reset()
		ports.post = post
		expect(await at(1_500_060)).toEqual({ post: false, reason: "asp_deferred" })
		expect((await at(1_800_000)).post).toBe(true)
		expect([s.fetches, s.record.sequence]).toEqual([7, 6n])

		// A size mismatch drops the list, and the feed is asked again only past the floor.
		s.record = { ...s.record, poolSize: 9n }
		expect(await at(1_800_030)).toEqual({ post: false, reason: "size_mismatch" })
		expect(await at(1_800_060)).toEqual({ post: false, reason: "asp_deferred" })
		expect(await at(2_100_000)).toEqual({ post: false, reason: "size_mismatch" })
		expect(s.fetches).toBe(8)
	})

	it("serves a post's sequence while the post awaits its checkpoint, and moves /latest only after it", async () => {
		const { s, ports } = chain()
		const book = new SnapshotBook()
		const bot = new Poster(ports, book, { self: SELF, inclusionMarginSec: 144n })
		expect((await bot.tick()).post).toBe(true)
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		const send = ports.post
		const sequenceOf = (body: string | undefined) => body && parseAspSnapshot(JSON.parse(body)).sequence
		const { promise: landed, resolve: land } = Promise.withResolvers<void>()
		const { promise: checkpointed, resolve: checkpoint } = Promise.withResolvers<void>()
		// The post lands at once; its checkpoint waits until the test releases it.
		ports.post = async (a) => {
			const done = await send(a)
			land()
			await checkpointed
			return done
		}
		const tick = bot.tick()
		await landed
		expect([sequenceOf(book.body(2n)), sequenceOf(book.body("latest"))]).toEqual([2n, 1n])
		checkpoint()
		expect((await tick).post).toBe(true)
		expect(sequenceOf(book.body("latest"))).toBe(2n)
	})
})
