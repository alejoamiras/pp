import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import { parseAspSnapshot } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { type BlockSource, selectBlock } from "./l1"
import { respond, SnapshotBook, serve } from "./server"

const leaves = [1n, 2n, 3n].map(aspLeaf)
const snapshot = (sequence: bigint) => ({
	sequence,
	poolRoot: buildLeanImt(leaves).root,
	birthRoot: 0n,
	poolLeaves: leaves,
	birthLeaves: [],
})

describe("snapshot routes", () => {
	it("serve only what this process holds, uncached, and nothing but GET", async () => {
		const book = new SnapshotBook()
		expect(respond("GET", "/v1/snapshots/latest", book).status).toBe(404)
		book.hold(snapshot(3n))
		book.hold(snapshot(4n))
		book.setCurrent(snapshot(4n))

		const ok = respond("GET", "/v1/snapshots/3?label=1", book)
		expect(ok.status).toBe(200)
		expect(parseAspSnapshot(JSON.parse(ok.body)).sequence).toBe(3n)
		expect(ok.headers).toEqual({
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
			"cross-origin-resource-policy": "cross-origin",
			"content-type": "application/json",
		})
		expect(parseAspSnapshot(JSON.parse(respond("GET", "/v1/snapshots/latest", book).body)).sequence).toBe(4n)
		for (const path of ["/v1/snapshots/5", "/v1/snapshots/0", "/v1/snapshots/03", "/v1/snapshots/..%2Fx", "/", "/v1/snapshots"]) {
			expect(respond("GET", path, book).status, path).toBe(404)
		}
		expect(respond("POST", "/v1/snapshots/latest", book).status).toBe(405)
		// After `set_poster`: the same sequence with cleared roots, which this process does not hold.
		book.setCurrent({ sequence: 4n, poolRoot: 0n, birthRoot: 0n })
		expect(respond("GET", "/v1/snapshots/latest", book).status).toBe(404)
		expect(respond("GET", "/v1/snapshots/4", book).status).toBe(200)

		const live = await serve(book)
		try {
			const res = await fetch(`${live.url}/v1/snapshots/3`)
			expect(res.headers.get("cache-control")).toBe("no-store")
			expect(parseAspSnapshot(await res.json()).sequence).toBe(3n)
		} finally {
			await live.close()
		}
		// Another post landed under 3 with other roots: the held body lost its race.
		book.setCurrent({ sequence: 3n, poolRoot: 7n, birthRoot: 0n })
		expect(respond("GET", "/v1/snapshots/3", book).status).toBe(404)
	})
})

describe("block selection", () => {
	it("takes the newest block at the tag whose time is not after Aztec's, within the walk-back bound", async () => {
		const blocks = Array.from({ length: 400 }, (_, i) => ({
			number: BigInt(i),
			hash: "0x01" as const,
			timestamp: 1_000n + 12n * BigInt(i),
		}))
		const tags: string[] = []
		const src: BlockSource = {
			head: async (tag) => {
				tags.push(tag)
				return blocks[399]!
			},
			at: async (n) => blocks[Number(n)]!,
		}
		expect((await selectBlock(src, "finalized", 1_000n + 12n * 390n + 5n))?.number).toBe(390n)
		expect((await selectBlock(src, "finalized", 1_000n + 12n * 399n))?.number).toBe(399n)
		expect(await selectBlock(src, "finalized", 1_000n + 12n * 142n)).toBeNull()
		expect(tags).toEqual(["finalized", "finalized", "finalized"])
	})
})
