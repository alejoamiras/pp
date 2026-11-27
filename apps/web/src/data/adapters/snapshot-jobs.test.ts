import { aspLeaf, buildLeanImt, leanImtRoot } from "@pp/bridge-spec"
import { MAX_LEAVES, type RootRecord, serializeAspSnapshot } from "@pp/label-paths"
import { describe, expect, test } from "vitest"
import { snapshotJobs } from "./snapshot-jobs"
import { type JobReply, type JobRequest, rootsKey } from "./snapshot-protocol"

const LISTED = [11n, 22n, 33n, 44n]
const poolLeaves = LISTED.map(aspLeaf)
const poolRoot = buildLeanImt(poolLeaves).root
const record: RootRecord = { sequence: 7n, poolRoot, birthRoot: 0n, l1Block: 1n, rootTime: 1_000n }
const KEY = rootsKey(record)
const text = (sequence = 7n) => serializeAspSnapshot({ sequence, poolRoot, birthRoot: 0n, poolLeaves, birthLeaves: [] })

function rig() {
	const replies: JobReply[] = []
	const jobs = snapshotJobs((r) => replies.push(r))
	const send = (req: JobRequest): JobReply[] => {
		replies.length = 0
		jobs.handle(req)
		return [...replies]
	}
	const load = (body = text(), roots = { poolRoot, birthRoot: 0n }) => send({ kind: "load", key: KEY, text: body, roots })
	const check = (label: bigint) => send({ kind: "check", key: KEY, record, label, origin: 0, nowSec: 1_000n })
	return { load, check }
}

const hashing = (replies: JobReply[]) => replies.filter((r) => r.kind === "progress")
/** Tree builds among `replies`: each build's first hash reports `hashed` 1. */
const builds = (replies: JobReply[]) => hashing(replies).filter((r) => r.kind === "progress" && r.hashed === 1).length
const outcome = (replies: JobReply[]) => replies.at(-1)

describe("the allow-list worker", () => {
	test("refuses a list whose declared roots are not the record's before hashing anything", () => {
		const w = rig()
		expect(w.load(text(), { poolRoot: poolRoot + 1n, birthRoot: 0n })).toEqual([{ kind: "failed", failure: "MISMATCH" }])
		expect(w.check(11n)).toEqual([{ kind: "failed", failure: "NOT_LOADED" }])
	})

	test("answers an absent label with no tree built, and builds one tree for every found label of a list", () => {
		const w = rig()
		expect(w.load()).toEqual([{ kind: "loaded" }])
		expect(w.check(99n)).toEqual([{ kind: "checked", result: { state: "ABSENT" } }])
		const first = w.check(11n)
		expect(builds(first)).toBe(1)
		const found = outcome(first)
		if (found?.kind !== "checked" || found.result.state !== "ACTIVE") throw new Error(`not active: ${JSON.stringify(found, String)}`)
		expect(leanImtRoot(aspLeaf(11n), found.result.path)).toBe(poolRoot)
		expect(hashing(w.check(22n))).toEqual([])
		// The same roots under a new sequence carry the same list: its kept tree answers.
		expect(w.load(text(8n))).toEqual([{ kind: "loaded" }])
		const again = w.check(33n)
		expect(hashing(again)).toEqual([])
		expect(outcome(again)).toMatchObject({ kind: "checked", result: { state: "ACTIVE" } })
	})

	test("drops a list whose found label's tree does not build to the declared root", () => {
		const w = rig()
		const forged = JSON.parse(text())
		forged.poolLeaves = [...forged.poolLeaves.slice(1), String(aspLeaf(55n))]
		expect(w.load(JSON.stringify(forged))).toEqual([{ kind: "loaded" }])
		const replies = w.check(22n)
		expect(builds(replies)).toBe(1)
		expect(outcome(replies)).toEqual({ kind: "failed", failure: "MISMATCH" })
		expect(w.check(33n)).toEqual([{ kind: "failed", failure: "NOT_LOADED" }])
	})

	test("calls a list longer than any tree oversized, and one it cannot read a mismatch", () => {
		const w = rig()
		const long = JSON.stringify({
			sequence: "7",
			poolRoot: String(poolRoot),
			birthRoot: "0",
			poolLeaves: Array(MAX_LEAVES + 1).fill("1"),
			birthLeaves: [],
		})
		expect(w.load(long)).toEqual([{ kind: "failed", failure: "OVERSIZED" }])
		for (const body of ["not json", "{}", text().replace(`"${poolLeaves[0]}"`, '"0x1"')])
			expect(w.load(body)).toEqual([{ kind: "failed", failure: "MISMATCH" }])
	})
})
