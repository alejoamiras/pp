import * as fc from "fast-check"
import type { Hash } from "viem"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../../vitest.base"
import { type AttemptState, type Intent, MAX_UNRESOLVED_ATTEMPTS, planAttempt } from "./attempts"
import type { JournalAttempt, JournalRecord } from "./journal"

const NULLIFIER = 7n
const hash = fc.integer({ min: 1, max: 2 ** 30 }).map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hash)
type Tried = { attempt: JournalAttempt; state: AttemptState }

// What `observe` can report: a hashless attempt stays hashless, so only a sent one can revert.
const open = fc.oneof(
	hash.chain((h) => fc.constantFrom<AttemptState>("pending", "unknown").map((state) => ({ attempt: { l1TxHash: h }, state }))),
	fc.constant<Tried>({ attempt: {}, state: "hashless" }),
)
const reverted = hash.map((h): Tried => ({ attempt: { l1TxHash: h }, state: "reverted" }))
// A write keeps at most MAX_UNRESOLVED_ATTEMPTS attempts, and one that reverts later keeps its slot. Half the
// records are full of open attempts, the only ones that evict.
const tries = fc
	.oneof(fc.constant(MAX_UNRESOLVED_ATTEMPTS), fc.integer({ min: 0, max: MAX_UNRESOLVED_ATTEMPTS - 1 }))
	.chain((n) =>
		fc.tuple(
			fc.array(open, { minLength: n, maxLength: n }),
			fc.array(reverted, { minLength: n === 0 ? 1 : 0, maxLength: MAX_UNRESOLVED_ATTEMPTS - n }),
		),
	)
	.chain(([o, r]) => fc.shuffledSubarray([...o, ...r], { minLength: o.length + r.length }))

// Lowercase, as a record holds it, and full-length: another recipient differs at one digit, never in length.
const recipient = fc.stringMatching(/^[0-9a-f]{64}$/).map((h) => `0x${h}`)
const another = (r: string, at: number) => `${r.slice(0, 2 + at)}${r[2 + at] === "0" ? "1" : "0"}${r.slice(3 + at)}`

/** Reachable inputs: no record, the evicted empty record of the caller's intent an unreadable one becomes, or a written one. */
const input = fc
	.record({
		kind: fc.constantFrom("none", "unreadable", "written"),
		tries,
		evicted: fc.boolean(),
		recipient,
		amount: fc.bigInt({ min: 1n, max: 3n }),
		recipientChange: fc.constantFrom("same", "case", "other"),
		at: fc.nat(63),
		otherAmount: fc.boolean(),
		accept: fc.boolean(),
	})
	.map((v) => {
		const recorded = { nullifier: NULLIFIER, recipient: v.recipient, amount: v.amount }
		const intent: Intent = {
			nullifier: NULLIFIER,
			recipient: { same: v.recipient, case: v.recipient.toUpperCase().replace("0X", "0x"), other: another(v.recipient, v.at) }[
				v.recipientChange
			],
			amount: v.otherAmount ? v.amount + 1n : v.amount,
		}
		const used = v.kind === "written" ? v.tries : []
		const record: JournalRecord | null =
			v.kind === "none"
				? null
				: v.kind === "unreadable"
					? { ...intent, attempts: [], evicted: true }
					: { ...recorded, attempts: used.map((t) => t.attempt), ...(v.evicted ? { evicted: true as const } : {}) }
		return {
			record,
			states: used.map((t) => t.state),
			intent,
			accept: v.accept,
			sameIntent: v.kind === "unreadable" || (v.recipientChange !== "other" && !v.otherAmount),
		}
	})

describe("planAttempt properties (every reachable record)", () => {
	const decision = propertyParams(
		import.meta.url,
		"sends exactly when no earlier send can still land, or the override covers it",
		1_000,
		1_500,
	)
	it(
		"sends exactly when no earlier send can still land, or the override covers it",
		() => {
			fc.assert(
				fc.property(input, ({ record, states, intent, accept, sameIntent }) => {
					const plan = planAttempt(record, states, intent, accept)
					const unresolved = states.flatMap((s, i) => (s === "reverted" ? [] : [record?.attempts[i] as JournalAttempt]))
					const pending = states.includes("pending")
					const clear = record === null || (unresolved.length === 0 && record.evicted !== true)
					const sends = clear || (!pending && accept && sameIntent)
					expect(plan.kind).toBe(sends ? "send" : "refuse")
					if (plan.kind === "refuse") {
						expect(plan.code).toBe(pending ? "IN_FLIGHT" : "UNCERTAIN")
						expect(plan.hashes).toEqual(unresolved.flatMap((a) => (a.l1TxHash ? [a.l1TxHash] : [])))
					}
				}),
				decision.fc,
			)
		},
		decision.testTimeout,
	)

	const written = propertyParams(
		import.meta.url,
		"a send appends one hashless attempt, drops the oldest only at the cap, and never clears evicted",
		1_000,
		1_500,
	)
	it(
		"a send appends one hashless attempt, drops the oldest only at the cap, and never clears evicted",
		() => {
			fc.assert(
				fc.property(input, ({ record, states, intent, accept }) => {
					const plan = planAttempt(record, states, intent, accept)
					fc.pre(plan.kind === "send")
					if (plan.kind !== "send") return
					const next = plan.record
					const unresolved = states.flatMap((s, i) => (s === "reverted" ? [] : [record?.attempts[i] as JournalAttempt]))
					if (record === null || (unresolved.length === 0 && record.evicted !== true)) {
						expect(next).toEqual({ ...intent, attempts: [{}] })
						return
					}
					const full = unresolved.length >= MAX_UNRESOLVED_ATTEMPTS
					expect(next.attempts.length).toBeLessThanOrEqual(MAX_UNRESOLVED_ATTEMPTS)
					expect(next.attempts.at(-1)).toEqual({})
					expect(next.attempts.slice(0, -1)).toEqual(full ? unresolved.slice(1) : unresolved)
					expect(next.evicted === true).toBe(record.evicted === true || full)
					expect({ nullifier: next.nullifier, recipient: next.recipient, amount: next.amount }).toEqual({
						nullifier: record.nullifier,
						recipient: record.recipient,
						amount: record.amount,
					})
				}),
				written.fc,
			)
		},
		written.testTimeout,
	)
})
