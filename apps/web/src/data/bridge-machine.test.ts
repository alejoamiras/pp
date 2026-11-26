import { describe, expect, test } from "vitest"
import type { AztecAddress, BridgeRecordView } from "./a7"
import { type BridgeEvent, type BridgeMachine, bridgeReducer, type Failure, initialBridge, MAX_NOTICES } from "./bridge-machine"
import type { Attempt } from "./ports"

const recipient = `0x${"1c".repeat(32)}` as AztecAddress
const attempt: Attempt = {
	seq: 1,
	owner: "0x0000000000000000000000000000000000000001",
	sender: "0x0000000000000000000000000000000000000002",
	recipient,
	deployment: "d",
	chainId: 31337,
	epoch: 1,
	note: 7n,
	amount: 5n,
}
const binding = { recipient, epoch: 1, at: 0 }
const record = (step: BridgeRecordView["step"]): BridgeRecordView => ({ id: "r", nullifier: 9n, recipient, amount: 5n, step })
const fail = (code: Failure["code"], offer: Failure["offer"], during: Failure["during"] = "prepared"): BridgeEvent => ({
	type: "failed",
	failure: { code, offer, during },
})

const run = (...events: BridgeEvent[]) => events.reduce(bridgeReducer, initialBridge)
const S = {
	idle: () => initialBridge,
	ready: () => run({ type: "preflight" }, { type: "preflighted", binding }),
	starting: () => run({ type: "preflight" }, { type: "preflighted", binding }, { type: "submit", attempt }),
	proving: () => bridgeReducer(S.starting(), { type: "proving" }),
	sending: () => bridgeReducer(S.proving(), { type: "proved" }),
	submitted: () => bridgeReducer(S.sending(), { type: "handoff" }),
	mined: () => bridgeReducer(S.submitted(), { type: "record", record: record("mined") }),
	claimable: () => bridgeReducer(S.mined(), { type: "claimable" }),
	claiming: () => bridgeReducer(S.claimable(), { type: "claiming" }),
	pending: () => bridgeReducer(S.claiming(), { type: "claim-pending", txHash: "0xaa" }),
	claimed: () => bridgeReducer(S.claiming(), { type: "claimed" }),
}
const where = (m: BridgeMachine) => [m.step, m.phase]

describe("the bridge machine", () => {
	test.each([
		["idle, preflight", S.idle, { type: "preflight" }, ["preparing", "preflight"]],
		["preflight, preflighted", () => run({ type: "preflight" }), { type: "preflighted", binding }, ["preparing", "ready"]],
		["ready, invalidate", S.ready, { type: "invalidate" }, ["preparing", "idle"]],
		["ready, submit", S.ready, { type: "submit", attempt }, ["preparing", "starting"]],
		["idle, submit (the driver preflights)", S.idle, { type: "submit", attempt }, ["preparing", "starting"]],
		["starting, preflight again", S.starting, { type: "preflight" }, ["preparing", "preflight"]],
		["starting, proving", S.starting, { type: "proving" }, ["preparing", "proving"]],
		["proving, proved", S.proving, { type: "proved" }, ["prepared", "sending"]],
		["sending, handoff", S.sending, { type: "handoff" }, ["submitted", "waiting"]],
		["sending, wallet declines", S.sending, { type: "declined" }, ["preparing", "idle"]],
		["submitted, wallet declines", S.submitted, { type: "declined" }, ["preparing", "idle"]],
		["submitted, mined record", S.submitted, { type: "record", record: record("mined") }, ["mined", "waiting"]],
		[
			"sending, reverted record",
			S.sending,
			{ type: "record", record: record({ error: "REVERTED" }) },
			[{ error: "REVERTED" }, "failed"],
		],
		["mined, claimable", S.mined, { type: "claimable" }, ["claimable", "ready"]],
		["claimable, claiming", S.claimable, { type: "claiming" }, ["claiming", "sending"]],
		["claiming, wallet declines", S.claiming, { type: "claim-declined" }, ["claimable", "ready"]],
		["claiming, dropped", S.claiming, { type: "claim-pending", txHash: "0xaa" }, ["claiming", "pending"]],
		["claiming, claimed", S.claiming, { type: "claimed" }, ["claimed", "done"]],
		["pending, claimed later", S.pending, { type: "claimed" }, ["claimed", "done"]],
		["proving, failed", S.proving, fail("PROVE_TIMEOUT", "prove-again", "preparing"), [{ error: "PROVE_TIMEOUT" }, "failed"]],
		[
			"failed (prove again), submit",
			() => bridgeReducer(S.sending(), fail("REVERTED", "prove-again")),
			{ type: "submit", attempt },
			["preparing", "starting"],
		],
		[
			"failed (prepare again), preflight",
			() => bridgeReducer(S.proving(), fail("CONTEXT_CHANGED", "prepare-again")),
			{ type: "preflight" },
			["preparing", "preflight"],
		],
		[
			"failed (claim), claiming",
			() => bridgeReducer(S.claiming(), fail("CLAIM_REVERTED", "claim", "claiming")),
			{ type: "claiming" },
			["claiming", "sending"],
		],
		["any, reset", S.claimed, { type: "reset" }, ["preparing", "idle"]],
	] as const)("%s", (_name, from, event, to) => {
		expect(where(bridgeReducer(from(), event as BridgeEvent))).toEqual(to)
	})

	test.each([
		["a second Submit", S.starting, { type: "submit", attempt: { ...attempt, seq: 2 } }],
		["Submit while proving", S.proving, { type: "submit", attempt }],
		["Submit while a Submit's preflight runs", () => bridgeReducer(S.starting(), { type: "preflight" }), { type: "submit", attempt }],
		[
			"Submit after a failure that offers none",
			() => bridgeReducer(S.sending(), fail("IN_FLIGHT", "none")),
			{ type: "submit", attempt },
		],
		[
			"a preflight after a failure that offers none",
			() => bridgeReducer(S.sending(), fail("CONSUMED_ELSEWHERE", "none")),
			{ type: "preflight" },
		],
		["a claim resend while pending", S.pending, { type: "claiming" }],
		["invalidate once Submit froze an attempt", S.starting, { type: "invalidate" }],
		["proving out of order", S.idle, { type: "proving" }],
		["a failure after claimed", S.claimed, fail("UNKNOWN", "none")],
		["a record after claimed", S.claimed, { type: "record", record: record("mined") }],
	] as const)("ignores %s", (_name, from, event) => {
		const before = from()
		expect(bridgeReducer(before, event as BridgeEvent)).toBe(before)
	})

	test("keeps notices, newest last and bounded, without moving the step", () => {
		let m = S.sending()
		for (let i = 0; i < MAX_NOTICES + 3; i++) m = bridgeReducer(m, { type: "reproving", code: "ASP_ROOT_STALE" })
		m = bridgeReducer(m, { type: "refused", code: "SENDER_IS_OWNER" })
		expect(where(m)).toEqual(["prepared", "sending"])
		expect(m.notices).toHaveLength(MAX_NOTICES)
		expect(m.notices.at(-1)).toEqual({ kind: "refused", code: "SENDER_IS_OWNER" })
	})
})
