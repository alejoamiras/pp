import type { Address } from "viem"
import { describe, expect, test, vi } from "vitest"
import type { AztecAddress, BridgeRecordView, PoolNoteView, StaleRootCode } from "./a7"
import { createBridgeDriver, type LiveContext, PREFLIGHT_FRESH_MS, PROVE_DEADLINE_MS, type SubmitInput } from "./bridge-driver"
import { type BridgeEvent, type BridgeMachine, bridgeReducer, initialBridge } from "./bridge-machine"
import { openOwnerSession } from "./chain"
import { BridgeFailure, ProviderError } from "./errors"
import { bridgeView } from "./model"
import type { ClaimHooks, L1Port, Proved, Sent, Session, SessionPort, Timer } from "./ports"
import { type Eip1193Provider, guardedProvider } from "./wallet/guarded-provider"

const OWNER: Address = "0x00000000000000000000000000000000000000a1"
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const OTHER: Address = "0x00000000000000000000000000000000000000c3"
const RECIPIENT = `0x${"1c".repeat(32)}` as AztecAddress
const NOTE: PoolNoteView = { commitment: 7n, label: 3n, value: 100n, asset: OTHER, status: "approved" }
const MINED: BridgeRecordView = { id: "r1", nullifier: 9n, recipient: RECIPIENT, amount: 70n, step: "mined" }
const CLAIMABLE: BridgeRecordView = { ...MINED, step: "claimable" }
const INPUT: SubmitInput = { note: NOTE, amount: 70n, recipient: RECIPIENT }

type Gate = "preflight" | "prove" | "reprove" | "claim"

function virtualTimer(): Timer & { advance(ms: number): void } {
	let t = 0
	const sleeps = new Set<{ due: number; done: (elapsed: boolean) => void }>()
	return {
		now: () => t,
		sleep(ms, signal) {
			return new Promise<boolean>((resolve) => {
				const entry = { due: t + ms, done: resolve }
				sleeps.add(entry)
				signal?.addEventListener("abort", () => sleeps.delete(entry) && resolve(false), { once: true })
			})
		},
		advance(ms) {
			t += ms
			for (const s of [...sleeps]) if (s.due <= t) sleeps.delete(s) && s.done(true)
		},
	}
}

/**
 * A fake session whose calls can be held at named gates. Its submit sends through the guarded wallet
 * with the driver's `handoff`, as the stack adapter will, so `sent` counts what reached the wallet.
 */
function harness(script: { reproves?: StaleRootCode[]; submitThrows?: unknown; afterSend?: unknown; claim?: () => Promise<Sent> } = {}) {
	const ctx: { -readonly [K in keyof LiveContext]: LiveContext[K] } = {
		owner: OWNER,
		account: SENDER,
		chainId: 31337,
		deployment: "31337:portal:hub",
		epoch: 1,
		aztecAccounts: [RECIPIENT],
	}
	const order: string[] = []
	const sent: string[] = []
	const gates = new Map<Gate, { reached: () => void; open: Promise<void> }>()
	const opened = new Map<Gate, () => void>()
	const reached = new Map<Gate, Promise<void>>()
	const hold = (g: Gate) => {
		let reach = () => {}
		reached.set(g, new Promise<void>((r) => (reach = r)))
		gates.set(g, { reached: reach, open: new Promise<void>((r) => opened.set(g, r)) })
	}
	const pass = async (g: Gate) => {
		order.push(g)
		const gate = gates.get(g)
		if (!gate) return
		gate.reached()
		await gate.open
	}
	const wallet: Eip1193Provider = {
		async request({ method }) {
			sent.push(method)
			return `0x${"ab".repeat(32)}`
		},
	}
	const submitOpts: unknown[] = []
	const session: Session = {
		owner: OWNER,
		notes: async () => [NOTE],
		preflight: async () => pass("preflight"),
		warmUp: async () => {},
		prove: vi.fn(async () => {
			await pass("prove")
			return { note: NOTE.commitment, label: NOTE.label, amount: 70n, change: 30n } as Proved
		}),
		cancelProve: vi.fn(),
		submit: vi.fn(async (_p, a, on, o) => {
			submitOpts.push(o)
			if (script.submitThrows) throw script.submitThrows
			for (const code of script.reproves ?? []) on.reproving(code)
			if (script.reproves) await pass("reprove")
			await guardedProvider(wallet, on.handoff).request({ method: "eth_sendTransaction", params: [{ from: a.sender }] })
			if (script.afterSend) throw script.afterSend
			return MINED
		}),
		waitClaimable: async () => {},
		claim: vi.fn(async (_id: string, on: ClaimHooks): Promise<Sent> => {
			await pass("claim")
			on.handoff()
			sent.push("sendTx")
			return script.claim ? script.claim() : { txHash: "0xcc", status: "success" }
		}),
		records: async () => [],
		recover: async () => [],
		close: () => {},
	}
	const timer = virtualTimer()
	let canClaim = true
	const driver = createBridgeDriver({
		session,
		deployment: { id: ctx.deployment, chainId: 31337 },
		timer,
		frame: async () => {},
		context: () => ({ ...ctx, aztecAccounts: [...ctx.aztecAccounts] }),
		canClaim: () => canClaim,
	})
	let m: BridgeMachine = initialBridge
	const events: BridgeEvent[] = []
	const dispatch = (e: BridgeEvent) => {
		events.push(e)
		m = bridgeReducer(m, e)
	}
	const signal = new AbortController().signal
	return {
		ctx,
		session,
		timer,
		order,
		sent,
		submitOpts,
		hold,
		reached: (g: Gate) => reached.get(g) as Promise<void>,
		open: (g: Gate) => opened.get(g)?.(),
		denyClaim: () => {
			canClaim = false
		},
		preflight: () => driver.preflight(RECIPIENT, dispatch, signal),
		submit: (input: SubmitInput = INPUT, flags: { acceptUncertain?: true } = {}) => driver.submit(input, dispatch, signal, flags),
		claim: (r: BridgeRecordView = CLAIMABLE) => driver.claim(r, dispatch, signal),
		machine: () => m,
		events,
		/** Puts the machine where a claim starts. */
		atClaimable: () => {
			m = { ...initialBridge, step: "claimable", phase: "ready", record: CLAIMABLE }
		},
	}
}

const CHANGES = {
	account: (c: LiveContext & { account: Address | null }) => Object.assign(c, { account: OTHER }),
	chain: (c: LiveContext) => Object.assign(c, { chainId: 1 }),
	aztec: (c: LiveContext) => Object.assign(c, { epoch: 2 }),
} as const

describe("each refusal sends nothing", () => {
	test("a failed preflight stops the Submit that re-runs it", async () => {
		const h = harness()
		h.session.preflight = async () => {
			throw new BridgeFailure("FEE_PATH_FAILED")
		}
		await h.preflight()
		expect(h.machine().failure?.code).toBe("FEE_PATH_FAILED")
		await h.submit()
		expect(h.machine().failure).toMatchObject({ code: "FEE_PATH_FAILED", offer: "prepare-again" })
		expect(h.session.prove).not.toHaveBeenCalled()
		expect(h.sent).toEqual([])
	})

	test.each([
		["chain mismatch", (h: ReturnType<typeof harness>) => Object.assign(h.ctx, { chainId: 1 }), INPUT, "CHAIN_MISMATCH"],
		["sender is the owner", (h: ReturnType<typeof harness>) => Object.assign(h.ctx, { account: OWNER }), INPUT, "SENDER_IS_OWNER"],
		["invalid recipient", () => {}, { ...INPUT, recipient: "0x1234" }, "RECIPIENT_INVALID"],
		["recipient outside the wallet", () => {}, { ...INPUT, recipient: `0x${"2d".repeat(32)}` }, "RECIPIENT_NOT_IN_WALLET"],
		["amount above the note", () => {}, { ...INPUT, amount: 101n }, "AMOUNT_INVALID"],
	] as const)("%s", async (_name, arrange, input, code) => {
		const h = harness()
		arrange(h)
		expect(await h.submit(input)).toBeNull()
		expect(h.machine().notices.at(-1)).toEqual({ kind: "refused", code })
		expect(h.order).toEqual([])
		expect(h.session.submit).not.toHaveBeenCalled()
	})

	test("a wallet on another chain is never asked for the derivation signature", async () => {
		const signTypedData = vi.fn(async () => "0x00" as const)
		const l1 = { accounts: async () => [OWNER], chainId: async () => 1, signTypedData } as unknown as L1Port
		const open = vi.fn()
		expect(await openOwnerSession({ l1, sessions: { open } as unknown as SessionPort, chainId: 31337 })).toEqual({
			ok: false,
			code: "CHAIN_MISMATCH",
		})
		expect(signTypedData).not.toHaveBeenCalled()
		expect(open).not.toHaveBeenCalled()
	})

	test("a second Submit for the note is ignored", async () => {
		const h = harness()
		h.hold("prove")
		const first = h.submit()
		await h.reached("prove")
		expect(await h.submit()).toBeNull()
		h.open("prove")
		await first
		expect(h.session.submit).toHaveBeenCalledTimes(1)
		expect(h.sent).toEqual(["eth_sendTransaction"])
	})

	test.each(
		(["preflight", "prove", "reprove"] as const).flatMap((gate) =>
			(["account", "chain", "aztec"] as const).map((change) => [gate, change] as const),
		),
	)("a change while %s is held (%s) sends nothing", async (gate, change) => {
		const h = harness(gate === "reprove" ? { reproves: ["ASP_ROOT_STALE"] } : {})
		h.hold(gate)
		const run = h.submit()
		await h.reached(gate)
		CHANGES[change](h.ctx)
		h.open(gate)
		await run
		expect(h.sent).toEqual([])
		expect(h.machine().failure).toMatchObject({ code: "CONTEXT_CHANGED", offer: "prepare-again" })
		expect(bridgeView(h.machine()).message).toBe("Your wallet changed; nothing was sent.")
	})

	test.each(["account", "chain", "aztec"] as const)("a change while the claim build is held (%s) sends nothing", async (change) => {
		const h = harness()
		h.atClaimable()
		h.hold("claim")
		const run = h.claim()
		await h.reached("claim")
		CHANGES[change](h.ctx)
		h.open("claim")
		await run
		expect(h.sent).toEqual([])
		expect(h.machine().failure).toMatchObject({ code: "CONTEXT_CHANGED", offer: "claim" })
	})

	test("a claim the wallet did not grant is never asked for", async () => {
		const h = harness()
		h.atClaimable()
		h.denyClaim()
		await h.claim()
		expect(h.session.claim).not.toHaveBeenCalled()
		expect(h.machine().notices.at(-1)).toEqual({ kind: "refused", code: "NOT_GRANTED" })
	})
})

describe("the bridge driver", () => {
	test("shows each internal re-proof with the root that moved", async () => {
		const h = harness({ reproves: ["KEYSTORE_ROOT_STALE", "ASP_ROOT_STALE"] })
		await h.submit()
		expect(bridgeView(h.machine()).log).toEqual([
			"A root changed (keystore); proving again.",
			"A root changed (allow list); proving again.",
		])
		expect(h.machine().step).toBe("mined")
	})

	test("a prove that never settles hits the 60 s deadline on the injected timer, sends nothing and offers a retry", async () => {
		const h = harness()
		h.hold("prove")
		const run = h.submit()
		await h.reached("prove")
		h.timer.advance(PROVE_DEADLINE_MS - 1)
		await Promise.resolve()
		expect(h.machine().phase).toBe("proving")
		h.timer.advance(1)
		await run
		expect(h.session.cancelProve).toHaveBeenCalledTimes(1)
		expect(h.sent).toEqual([])
		expect(h.machine().failure).toMatchObject({ code: "PROVE_TIMEOUT", offer: "prove-again" })
		expect(bridgeView(h.machine()).message).toBe("Proving took too long; nothing was sent.")
	})

	test("an on-chain revert asks the user to prove again", async () => {
		const h = harness({ afterSend: new BridgeFailure("REVERTED", { stale: "STATE_ROOT_STALE" }) })
		await h.submit()
		expect(h.machine().step).toEqual({ error: "REVERTED" })
		expect(h.machine().failure).toMatchObject({
			code: "REVERTED",
			offer: "prove-again",
			during: "submitted",
			stale: "STATE_ROOT_STALE",
		})
		expect(h.session.submit).toHaveBeenCalledTimes(1)
	})

	test("a Submit more than 9 minutes after preflight preflights again first", async () => {
		const h = harness()
		await h.preflight()
		h.timer.advance(PREFLIGHT_FRESH_MS)
		await h.submit({ ...INPUT, note: { ...NOTE, commitment: 8n } })
		expect(h.order).toEqual(["preflight", "prove"])
		h.timer.advance(PREFLIGHT_FRESH_MS + 1)
		h.order.length = 0
		await h.submit()
		expect(h.order).toEqual(["preflight", "prove"])
	})

	test("after UNCERTAIN only an explicit retry with acceptUncertain runs; after IN_FLIGHT none does", async () => {
		const h = harness({ submitThrows: new BridgeFailure("UNCERTAIN") })
		await h.submit()
		expect(h.machine().failure).toMatchObject({ code: "UNCERTAIN", offer: "send-again" })
		await h.submit()
		expect(h.session.submit).toHaveBeenCalledTimes(1)
		await h.submit(INPUT, { acceptUncertain: true })
		expect(h.submitOpts).toEqual([undefined, { acceptUncertain: true }])

		const f = harness({ submitThrows: new BridgeFailure("IN_FLIGHT") })
		await f.submit()
		expect(f.machine().failure).toMatchObject({ code: "IN_FLIGHT", offer: "none" })
		await f.submit()
		await f.submit(INPUT, { acceptUncertain: true })
		expect(f.session.submit).toHaveBeenCalledTimes(1)
		expect(f.sent).toEqual([])
	})

	test("a wallet rejection on claim returns to claimable", async () => {
		const h = harness({
			claim: async () => {
				throw new ProviderError(4001, "User rejected the request.")
			},
		})
		h.atClaimable()
		await h.claim()
		expect([h.machine().step, h.machine().phase]).toEqual(["claimable", "ready"])
		expect(h.machine().failure).toBeNull()
	})

	test("a dropped claim stays pending and is never sent again", async () => {
		const h = harness({ claim: async () => ({ txHash: "0xdd", status: "dropped" }) })
		h.atClaimable()
		await h.claim()
		expect([h.machine().step, h.machine().phase, h.machine().claimTx]).toEqual(["claiming", "pending", "0xdd"])
		await h.claim()
		expect(h.session.claim).toHaveBeenCalledTimes(1)
	})
})
