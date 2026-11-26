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
		record: { sequence: 0n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n } as RootRecord,
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
		s.record = { ...posted, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n }
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
})
