import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import type { RootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { type Ports, Poster } from "./loop"
import { ownPosts } from "./own-posts"
import { SnapshotBook } from "./server"

const LEAVES = [aspLeaf(11n), aspLeaf(22n)]
const ROOT = buildLeanImt(LEAVES).root

describe("readiness over this process's own posts", () => {
	it("follows the newest own post when the read after the first one failed and a second one landed", async () => {
		const book = new SnapshotBook()
		const own = ownPosts(book)
		let record: RootRecord = { sequence: 0n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
		let posts = 0
		let l1 = 10n
		const ports: Ports = {
			tip: async () => ({ number: 10, hash: "0x01", time: 2_000n }),
			record: async () => record,
			poster: async () => 0xb07n,
			selectL1: async () => ({ number: l1, hash: "0x0a", timestamp: 1_900n }),
			aspRootAt: async () => ROOT,
			aspLeaves: async () => LEAVES,
			birthLeaves: async () => [],
			post: async (a) => {
				record = { ...a }
				own.posted({ sequence: a.sequence, txHash: "0xab", l2Block: 10 + ++posts })
				// The first post checkpointed, then its inclusion-block read failed.
				if (posts === 1) throw new Error("block 11 not found")
				return { inclusionTime: 1_990n }
			},
			log: () => {},
		}
		const poster = new Poster(ports, book, { self: 0xb07n, inclusionMarginSec: 300n })

		expect((await poster.tick(own.none())).post).toBe(false)
		expect(own.served()).toBeUndefined()
		l1 = 11n
		expect((await poster.tick(true)).post).toBe(true)
		expect(own.served()?.sequence).toBe(2n)
		expect(book.body("latest")).toBe(book.body(2n))
	})
})
