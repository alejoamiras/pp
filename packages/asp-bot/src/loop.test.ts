import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import { parseAspSnapshot, type RootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import type { L1Block, PostArgs } from "./decide"
import { type Ports, Poster } from "./loop"
import { SnapshotBook } from "./server"

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
		post: async (a: PostArgs) => {
			s.record = { ...a }
			return { inclusionTime: s.aztecTime + 72n }
		},
		log: (event) => s.logs.push(event),
	}
	return { s, ports }
}

describe("a tick", () => {
	it("posts only leaves that hash to the chain's root, keeps them in memory, and serves what it posted", async () => {
		const { s, ports } = chain()
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

		// `set_poster` keeps only the sequence; the old poster must stop serving `/latest` at once.
		const posted = s.record
		s.poster = 0xdeadn
		s.record = { ...posted, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
		expect(await bot.tick()).toEqual({ post: false, reason: "not_poster" })
		expect(book.body("latest")).toBeUndefined()
		s.record = posted
		ports.selectL1 = async () => {
			throw new Error("anvil down")
		}
		s.poster = SELF
		expect(await bot.tick()).toEqual({ post: false, reason: "error" })
		expect(s.logs).toEqual(["posted", "posted", "asp_root_mismatch", "posted", "not_poster", "tick_failed"])

		// A fresh process serves the record it finds current once the ASP's leaves rebuild its root.
		ports.selectL1 = async () => s.l1
		const fresh = new SnapshotBook()
		expect(await new Poster(ports, fresh, { self: SELF, inclusionMarginSec: 144n }).tick()).toEqual({
			post: false,
			reason: "unchanged",
		})
		expect(parseAspSnapshot(JSON.parse(fresh.body("latest")!)).sequence).toBe(3n)
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
		const { s, ports } = chain()
		// The feed lied when the bot posted: the root itself as the whole list.
		s.aspLeaves = [root(set1)]
		const bot = new Poster(ports, new SnapshotBook(), { self: SELF, inclusionMarginSec: 144n })
		expect((await bot.tick()).post).toBe(true)
		expect(s.record.poolSize).toBe(1n)
		// The feed is fixed, then the admin's set_poster clears the record.
		s.aspLeaves = set1
		s.record = { ...s.record, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
		s.aztecTime += 300n
		s.l1 = { number: 30n, hash: "0x0b", timestamp: 1_150n }
		expect((await bot.tick()).post).toBe(true)
		expect(s.record).toMatchObject({ sequence: 2n, poolRoot: root(set1), poolSize: 2n })
		expect(s.fetches).toBe(2)
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
		let pending = {}
		ports.post = async (a) => {
			s.record = { ...a }
			pending = { named: sequenceOf(book.body(a.sequence)), latest: sequenceOf(book.body("latest")) }
			return send(a)
		}
		expect((await bot.tick()).post).toBe(true)
		expect(pending).toEqual({ named: 2n, latest: 1n })
		expect(sequenceOf(book.body("latest"))).toBe(2n)
	})
})
