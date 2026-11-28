import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { type AllowedKind, aspAllowance } from "./asp-allowance"
import type { Forwarded } from "./proxy"

// The operator's limits, written out rather than imported: one request per URL per five minutes, the key per hour.
const FIVE_MIN = 5 * 60_000
const HOUR = 60 * 60_000
const windowOf = (kind: AllowedKind) => (kind === "public-key" ? HOUR : FIVE_MIN)

const ASP = "https://asp.example"
const SCOPE = `chainId=11155111&entrypoint=0x${"11".repeat(20)}`
const URLS: Record<AllowedKind, string> = {
	root: `${ASP}/association-set/root?${SCOPE}`,
	leaves: `${ASP}/association-set/leaves?${SCOPE}`,
	"public-key": `${ASP}/public-key`,
	snapshot: `${ASP}/11155111/public/event-snapshot/payload?entrypoint=0x${"11".repeat(20)}`,
}
const KINDS = Object.keys(URLS) as AllowedKind[]
const kindOf = (url: string) => KINDS.find((k) => URLS[k] === url) as AllowedKind

type Outcome = { type: "good" | "malformed" | "notFound" | "error" | "reject"; root: bigint; spelling: number }
const outcome: fc.Arbitrary<Outcome> = fc.record({
	type: fc.constantFrom("good", "malformed", "notFound", "error", "reject"),
	root: fc.constantFrom(1n, 2n),
	spelling: fc.nat(2),
})
// Window edges, the key's hour, and anything up to two windows.
const step = fc.oneof(fc.constantFrom(0, 1, FIVE_MIN - 1, FIVE_MIN, FIVE_MIN + 1, HOUR), fc.integer({ min: 0, max: 2 * FIVE_MIN }))
type Cmd = { probe: false; step: number; asks: AllowedKind[]; release: number } | { probe: true; step: number }
const cmd: fc.Arbitrary<Cmd> = fc.oneof(
	fc.record({
		probe: fc.constant(false as const),
		step,
		asks: fc.array(fc.constantFrom(...KINDS), { minLength: 1, maxLength: 3 }),
		release: fc.nat(3),
	}),
	fc.record({ probe: fc.constant(true as const), step }),
)

const bytes = (text: string) => new TextEncoder().encode(text)
/** A root answer in one of three spellings of the same value, so only the value can decide. */
const rootBody = (r: bigint, spelling: number) =>
	[`{"root":"${r}"}`, `{"root":"0x0${r.toString(16)}","at":1}`, `{"at":2,"root":"00${r}"}`][spelling] as string

function answer(kind: AllowedKind, o: Outcome, call: number): Forwarded {
	if (o.type === "error") return { ok: false, reason: "timeout" }
	if (o.type === "notFound") return { ok: true, status: 404, body: bytes("{}") }
	if (o.type === "malformed") return { ok: true, status: 200, body: bytes(kind === "leaves" ? '{"leaves":[1]}' : "<html>") }
	if (kind === "root") return { ok: true, status: 200, body: bytes(rootBody(o.root, o.spelling)) }
	return { ok: true, status: 200, body: bytes(kind === "leaves" ? `{"leaves":["${call}"]}` : "{}") }
}

/** What the allowance must have seen, kept from the upstream's side: each call, and each root and leaves outcome. */
class Ledger {
	readonly calls = new Map<string, number[]>()
	readonly gaps: string[] = []
	readonly leaves: { at: number; underRoot?: bigint; good: boolean }[] = []
	roots = 0
	/** The value of the last good root answer that was the latest root request when it came. */
	stored?: bigint
	latestRootGood = false

	called(url: string, at: number): void {
		const kind = kindOf(url)
		const times = this.calls.get(url) ?? []
		const last = times.at(-1)
		if (last !== undefined && at - last < windowOf(kind)) this.gaps.push(`${kind} asked again after ${at - last} ms`)
		this.calls.set(url, [...times, at])
		if (kind === "root") {
			this.roots++
			this.latestRootGood = false
		}
		if (kind === "leaves") this.leaves.push({ at, underRoot: this.latestRootGood ? this.stored : undefined, good: false })
	}

	settled(kind: AllowedKind, o: Outcome, rootIndex: number, leavesIndex: number): void {
		if (o.type !== "good") return
		if (kind === "leaves") (this.leaves[leavesIndex] as { good: boolean }).good = true
		if (kind === "root" && rootIndex === this.roots - 1) {
			this.stored = o.root
			this.latestRootGood = true
		}
	}
}

/** Lets every reaction to a settled answer run, as it would before the server's next request. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const reached = { kept: 0, refetched: 0 }

/** The allowance over a scheduled upstream that answers `outcomes` in turn, on a clock the run moves. */
function rig(s: fc.Scheduler, outcomes: Outcome[]) {
	const r = { now: 0, ledger: new Ledger(), pending: [] as Promise<Forwarded>[] }
	let n = 0
	const ask = aspAllowance(
		(url) => {
			const kind = kindOf(url)
			const o = outcomes[n % outcomes.length] as Outcome
			const call = n++
			r.ledger.called(url, r.now)
			const rootIndex = r.ledger.roots - 1
			const leavesIndex = r.ledger.leaves.length - 1
			return s.schedule(Promise.resolve(), `${kind} #${call} ${o.type}`).then(() => {
				r.ledger.settled(kind, o, rootIndex, leavesIndex)
				if (o.type === "reject") throw new Error("socket hang up")
				return answer(kind, o, call)
			})
		},
		URLS.root,
		() => r.now,
	)
	const settle = async () => {
		for (await flush(); s.count() > 0; await flush()) await s.waitOne()
	}
	return { r, ask, settle }
}

/** A lone leaves request once everything before it has settled, so what it serves is the latest leaves window. */
async function probe({ r, ask, settle }: ReturnType<typeof rig>): Promise<void> {
	await settle()
	const before = r.ledger.leaves.length
	const asked = ask(URLS.leaves, "leaves")
	await settle()
	await asked
	if (r.ledger.leaves.length > before) {
		if (before > 0) reached.refetched++
		return
	}
	const served = r.ledger.leaves.at(-1)
	if (served === undefined || r.now - served.at < FIVE_MIN) return
	reached.kept++
	expect(served.good, "leaves served past their window came from a good answer").toBe(true)
	expect(served.underRoot, "and were fetched under a root").toBeDefined()
	expect(served.underRoot, "which is still the stored root").toBe(r.ledger.stored)
}

async function run(s: fc.Scheduler, outcomes: Outcome[], cmds: Cmd[]): Promise<void> {
	const t = rig(s, outcomes)
	for (const c of cmds) {
		t.r.now += c.step
		if (c.probe) {
			await probe(t)
			continue
		}
		for (const kind of c.asks) t.r.pending.push(t.ask(URLS[kind], kind))
		for (let i = 0; i < c.release && s.count() > 0; i++) {
			await s.waitOne()
			await flush()
		}
	}
	await t.settle()
	await Promise.all(t.r.pending)
	expect(t.r.ledger.gaps).toEqual([])
}

describe("the operator's ASP allowance", () => {
	const name =
		"holds one request per URL per window under any interleaving, and serves leaves past their window only under the stored root"
	const p = propertyParams(import.meta.url, name, 300, 20_000)
	it(
		name,
		async () => {
			await fc.assert(
				fc.asyncProperty(fc.scheduler(), fc.array(outcome, { minLength: 1, maxLength: 12 }), fc.array(cmd, { maxLength: 30 }), run),
				p.fc,
			)
			// A lone request found its leaves past their window both kept and asked again, so the second half is not vacuous.
			expect(reached.kept).toBeGreaterThan(0)
			expect(reached.refetched).toBeGreaterThan(0)
		},
		p.testTimeout,
	)
})
