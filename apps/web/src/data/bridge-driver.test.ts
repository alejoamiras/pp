import type { Address, Hex, TypedDataDefinition } from "viem"
import { describe, expect, test, vi } from "vitest"
import type { AztecAddress, BridgeRecordView, PoolNoteView, StaleRootCode } from "./stack-types"
import {
	createBridgeDriver,
	createOutstanding,
	type LiveContext,
	PREFLIGHT_FRESH_MS,
	PROVE_DEADLINE_MS,
	type SubmitInput,
} from "./bridge-driver"
import { type BridgeEvent, type BridgeMachine, bridgeReducer, initialBridge } from "./bridge-machine"
import { openOwnerSession } from "./chain"
import { BridgeFailure, ProviderError } from "./errors"
import { bridgeView } from "./model"
import type { ClaimHooks, L1Port, Proved, Sent, Session, SessionPort } from "./ports"
import { type Eip1193Provider, guardedProvider } from "./wallet/guarded-provider"
import { virtualTimer } from "../test-utils/timer"

const OWNER: Address = "0x00000000000000000000000000000000000000a1"
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const OTHER: Address = "0x00000000000000000000000000000000000000c3"
const RECIPIENT = `0x${"1c".repeat(32)}` as AztecAddress
const NOTE: PoolNoteView = { commitment: 7n, label: 3n, value: 100n, asset: OTHER, status: "approved" }
const MINED: BridgeRecordView = { id: "r1", nullifier: 9n, recipient: RECIPIENT, amount: 70n, step: "mined" }
const CLAIMABLE: BridgeRecordView = { ...MINED, step: "claimable" }
const INPUT: SubmitInput = { note: NOTE, amount: 70n, recipient: RECIPIENT }
/** A wallet whose events report the owner on 31337, under the page's latest sign-in. */
const STEADY = { selected: () => ({ account: OWNER, chainId: 31337 }), current: () => true }

type Gate = "preflight" | "prove" | "reprove" | "claim" | "wallet"

/**
 * A fake session whose calls can be held at named gates. Its submit sends through the guarded wallet
 * with the driver's `handoff`, as the stack adapter will, so `sent` counts what reached the wallet.
 */
function harness(script: { reproves?: StaleRootCode[]; submitThrows?: unknown; afterSend?: unknown; claim?: () => Promise<Sent> } = {}) {
	const ctx: { -readonly [K in keyof LiveContext]: LiveContext[K] } = {
		owner: OWNER,
		account: SENDER,
		selected: SENDER,
		demo: false,
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
			const gate = gates.get("wallet")
			if (gate) {
				gate.reached()
				await gate.open
			}
			return `0x${"ab".repeat(32)}`
		},
	}
	const submitOpts: unknown[] = []
	const session: Session = {
		owner: OWNER,
		notes: async () => [NOTE],
		nullifierOf: async (c) => c + 1n,
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
		l1TxState: async () => "unknown",
		close: () => {},
	}
	const timer = virtualTimer()
	let canClaim = true
	// One per page, as `useBridgeFlow` keeps it: every driver the page creates shares it.
	const outstanding = createOutstanding()
	const make = () =>
		createBridgeDriver({
			session,
			deployment: { id: ctx.deployment, chainId: 31337 },
			timer,
			frame: async () => {},
			context: () => ({ ...ctx, aztecAccounts: [...ctx.aztecAccounts] }),
			canClaim: () => canClaim,
			outstanding,
		})
	let driver = make()
	let m: BridgeMachine = initialBridge
	const events: BridgeEvent[] = []
	const dispatch = (e: BridgeEvent) => {
		events.push(e)
		m = bridgeReducer(m, e)
	}
	let run = new AbortController()
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
		preflight: () => driver.preflight(RECIPIENT, dispatch, run.signal),
		submit: (input: SubmitInput = INPUT, flags: { acceptUncertain?: true } = {}) => driver.submit(input, dispatch, run.signal, flags),
		check: () => driver.check({ note: NOTE, recipient: RECIPIENT }, dispatch, run.signal),
		claim: (r: BridgeRecordView = CLAIMABLE) => driver.claim(r, dispatch, run.signal),
		/** What opening another bridge does: aborts the running flow and resets the screen. */
		supersede: () => {
			run.abort()
			run = new AbortController()
			dispatch({ type: "reset" })
		},
		/** What signing out and back in does: the running flow is aborted and a new driver takes over. */
		newSession: () => {
			run.abort()
			run = new AbortController()
			dispatch({ type: "reset" })
			driver = make()
		},
		follow: (r: BridgeRecordView) => driver.follow(r, dispatch, run.signal),
		machine: () => m,
		events,
		/** Puts the machine where a claim starts. */
		atClaimable: () => {
			m = { ...initialBridge, step: "claimable", phase: "ready", record: CLAIMABLE }
		},
	}
}

const CHANGES = {
	account: (c: LiveContext) => Object.assign(c, { account: OTHER, selected: OTHER }),
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
		expect(await openOwnerSession({ l1, sessions: { open } as unknown as SessionPort, chainId: 31337, ...STEADY })).toEqual({
			ok: false,
			code: "CHAIN_MISMATCH",
		})
		expect(signTypedData).not.toHaveBeenCalled()
		expect(open).not.toHaveBeenCalled()
	})

	test("a chain switched after the check but before the session asks to sign is never signed on", async () => {
		const chains = [31337, 1]
		const signTypedData = vi.fn(async () => "0x00" as const)
		const l1 = { accounts: async () => [OWNER], chainId: async () => chains.shift() ?? 1, signTypedData } as unknown as L1Port
		const sessions = {
			open: async (a: { sign(td: TypedDataDefinition): Promise<Hex> }) => {
				await a.sign({} as TypedDataDefinition)
				return {} as Session
			},
		} as unknown as SessionPort
		expect(await openOwnerSession({ l1, sessions, chainId: 31337, ...STEADY })).toEqual({ ok: false, code: "CHAIN_MISMATCH" })
		expect(signTypedData).not.toHaveBeenCalled()
	})

	test("an account switched while the session reads before signing, or a newer sign-in, never reaches the wallet", async () => {
		const selected = { account: OWNER as Address | null, chainId: 31337 as number | null }
		let release = () => {}
		const reads: Promise<void>[] = [Promise.resolve(), new Promise<void>((r) => (release = r))]
		const signTypedData = vi.fn(async () => "0x00" as const)
		const l1 = {
			accounts: async () => [OWNER],
			chainId: async () => {
				await reads.shift()
				return 31337
			},
			signTypedData,
		} as unknown as L1Port
		const sessions = {
			open: async (a: { sign(td: TypedDataDefinition): Promise<Hex> }) => {
				await a.sign({} as TypedDataDefinition)
				return {} as Session
			},
		} as unknown as SessionPort
		// eth_accounts answers first; the wallet reports the switch before eth_chainId answers.
		const opening = openOwnerSession({ l1, sessions, chainId: 31337, selected: () => selected, current: () => true })
		await new Promise((r) => setTimeout(r, 0))
		selected.account = OTHER
		release()
		expect(await opening).toEqual({ ok: false, code: "CONTEXT_CHANGED" })
		const superseded = openOwnerSession({
			l1,
			sessions,
			chainId: 31337,
			selected: () => ({ ...selected, account: OWNER }),
			current: () => false,
		})
		expect(await superseded).toEqual({ ok: false, code: "CONTEXT_CHANGED" })
		expect(signTypedData).not.toHaveBeenCalled()
	})

	test("a bridge made under the demo choice sends nothing once the choice is cleared, even with the wallet on the dev address", async () => {
		const h = harness()
		// The wallet itself selects the dev account, so clearing the choice leaves the sender unchanged.
		Object.assign(h.ctx, { account: OTHER, selected: OTHER, demo: true })
		h.hold("prove")
		const run = h.submit()
		await h.reached("prove")
		Object.assign(h.ctx, { demo: false })
		h.open("prove")
		await run
		expect(h.sent).toEqual([])
		expect(h.machine().failure?.code).toBe("CONTEXT_CHANGED")
	})

	test("a wallet change before viem's second send method reports the change, not a decline", async () => {
		const h = harness()
		h.session.submit = vi.fn(async (_p, a, on) => {
			const wallet: Eip1193Provider = {
				async request({ method }) {
					if (method !== "eth_sendTransaction") return `0x${"ab".repeat(32)}`
					Object.assign(h.ctx, { account: OTHER, selected: OTHER })
					throw Object.assign(new Error("the method does not exist"), { code: -32601 })
				},
			}
			// viem 2.57.1 retries a -32601 as wallet_sendTransaction, which runs the handoff again.
			const guarded = guardedProvider(wallet, on.handoff)
			const params = [{ from: a.sender }]
			await guarded
				.request({ method: "eth_sendTransaction", params })
				.catch(() => guarded.request({ method: "wallet_sendTransaction", params }))
			return MINED
		})
		await h.submit()
		expect(h.machine().failure?.code).toBe("CONTEXT_CHANGED")
		expect(h.machine().notices).not.toContainEqual({ kind: "declined" })
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

	test("a claim grant withdrawn while the claim build is held sends nothing", async () => {
		const h = harness()
		h.atClaimable()
		h.hold("claim")
		const run = h.claim()
		await h.reached("claim")
		h.denyClaim()
		h.open("claim")
		await run
		expect(h.sent).toEqual([])
		expect(h.machine().failure).toMatchObject({ code: "NOT_GRANTED", offer: "claim" })
	})

	test("a claim is bound to the connection it started under", async () => {
		const h = harness()
		h.atClaimable()
		await h.claim()
		expect(h.session.claim).toHaveBeenCalledWith(CLAIMABLE.id, expect.objectContaining({ epoch: 1 }))
	})

	test.each(["reprove", "claim"] as const)("a superseded run held at %s never reaches the wallet or the new screen", async (gate) => {
		const h = harness(gate === "reprove" ? { reproves: ["ASP_ROOT_STALE"] } : {})
		if (gate === "claim") h.atClaimable()
		h.hold(gate)
		const run = gate === "claim" ? h.claim() : h.submit()
		await h.reached(gate)
		h.supersede()
		h.open(gate)
		await run
		expect(h.sent).toEqual([])
		expect(h.machine()).toEqual(initialBridge)
	})

	test("a bridge spends only while the claim stays granted, checked at Submit and at the handoff", async () => {
		const h = harness()
		h.denyClaim()
		await h.submit()
		expect(h.machine().notices.at(-1)).toEqual({ kind: "refused", code: "NOT_GRANTED" })
		expect(h.session.prove).not.toHaveBeenCalled()

		const late = harness({ reproves: ["ASP_ROOT_STALE"] })
		late.hold("reprove")
		const run = late.submit()
		await late.reached("reprove")
		late.denyClaim()
		late.open("reprove")
		await run
		expect(late.sent).toEqual([])
		expect(late.machine().failure?.code).toBe("NOT_GRANTED")
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

	test("aborting a run whose proof hangs cancels the proof, so the note can be bridged again", async () => {
		const h = harness()
		let calls = 0
		let cancel = () => {}
		h.session.prove = vi.fn(async () => {
			if (++calls > 1) return { note: NOTE.commitment, label: NOTE.label, amount: 70n, change: 30n } as Proved
			return new Promise<Proved>((_, reject) => {
				cancel = () => reject(new Error("cancelled"))
			})
		})
		h.session.cancelProve = vi.fn(() => cancel())
		const run = h.submit()
		await vi.waitFor(() => expect(calls).toBe(1))
		h.supersede()
		await run
		expect(h.session.cancelProve).toHaveBeenCalledTimes(1)
		await h.submit()
		expect(h.sent).toEqual(["eth_sendTransaction"])
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

	test("a preflight's age counts from its answer, not from the warm-up after it", async () => {
		const h = harness()
		h.session.warmUp = async () => h.timer.advance(2 * 60_000)
		await h.preflight()
		h.timer.advance(PREFLIGHT_FRESH_MS - 60_000)
		h.order.length = 0
		await h.submit()
		expect(h.order).toEqual(["preflight", "prove"])
	})

	test("after UNCERTAIN a Submit without the override still reaches the session and the override is passed on; after IN_FLIGHT nothing is sent", async () => {
		const h = harness({ submitThrows: new BridgeFailure("UNCERTAIN") })
		await h.submit()
		expect(h.machine().failure).toMatchObject({ code: "UNCERTAIN", offer: "send-again" })
		await h.submit()
		await h.submit(INPUT, { acceptUncertain: true })
		expect(h.submitOpts).toEqual([undefined, undefined, { acceptUncertain: true }])

		const f = harness({ submitThrows: new BridgeFailure("IN_FLIGHT") })
		await f.submit()
		expect(f.machine().failure).toMatchObject({ code: "IN_FLIGHT", offer: "none" })
		await f.submit()
		await f.submit(INPUT, { acceptUncertain: true })
		expect(f.session.submit).toHaveBeenCalledTimes(1)
		expect(f.sent).toEqual([])
	})

	test.each([
		["no hash the chain knows", {}, "UNCERTAIN"],
		["a hash pending at the RPC", { tx: "pending" }, "IN_FLIGHT"],
		["its note spent by another transaction", { spent: true }, "CONSUMED_ELSEWHERE"],
		["its own hash mined and its note spent, the event not read yet", { tx: "mined", spent: true }, "IN_FLIGHT"],
		["the bridge's event on chain", { seen: true }, null],
	] as const)("an open record with %s answers a Submit without the override, before any proof", async (_name, o, code) => {
		const h = harness()
		const open: BridgeRecordView = {
			id: "r0",
			nullifier: NOTE.commitment + 1n,
			recipient: RECIPIENT,
			amount: 70n,
			step: "submitted",
			...("tx" in o ? { l1TxHash: `0x${"ef".repeat(32)}` as Hex } : {}),
		}
		h.session.records = async () => [open]
		h.session.l1TxState = async () => ("tx" in o ? o.tx : "unknown")
		h.session.recover = async () => ("seen" in o ? [{ ...open, step: "mined" }] : [])
		if ("spent" in o) h.session.notes = async () => [{ ...NOTE, status: "spent" }]
		const record = await h.submit()
		expect(h.session.prove).not.toHaveBeenCalled()
		if (code === null) expect([record?.step, h.machine().step]).toEqual(["mined", "mined"])
		else expect(h.machine().failure?.code).toBe(code)
	})

	test.each([
		["its last attempt reverted and none open", { reverted: true }, "REVERTED"],
		["no record left and its note unspent", {}, "UNCERTAIN"],
		["no record left and its note spent", { spent: true }, "CONSUMED_ELSEWHERE"],
		["no record left and the bridge's event for the recipient", { seen: true }, null],
	] as const)("Check again with %s shows that and never proves or submits", async (_name, o, code) => {
		const h = harness()
		const base = { id: "r0", nullifier: NOTE.commitment + 1n, recipient: RECIPIENT, amount: 70n }
		const hash = `0x${"ef".repeat(32)}` as Hex
		if ("reverted" in o) h.session.records = async () => [{ ...base, l1TxHash: hash, step: { error: "REVERTED" } }]
		if ("seen" in o) h.session.recover = async () => [{ ...base, l1TxHash: hash, step: "mined" }]
		if ("spent" in o) h.session.notes = async () => [{ ...NOTE, status: "spent" }]
		const record = await h.check()
		expect(h.session.prove).not.toHaveBeenCalled()
		expect(h.session.submit).not.toHaveBeenCalled()
		expect(h.sent).toEqual([])
		if (code === null) expect([record?.step, h.machine().step]).toEqual(["mined", "mined"])
		else expect(h.machine().failure?.code).toBe(code)
	})

	test("a Check again answer that lands after a Submit started is dropped whole: no screen change, nothing remembered", async () => {
		const h = harness()
		let release = () => {}
		const held = new Promise<void>((r) => (release = r))
		const pending = { id: "r0", nullifier: NOTE.commitment + 1n, recipient: RECIPIENT, amount: 70n, step: "submitted" as const }
		h.session.records = async () => {
			await held
			return [{ ...pending, l1TxHash: `0x${"ef".repeat(32)}` as Hex }]
		}
		h.session.l1TxState = async () => "pending"
		const checking = h.check()
		await h.submit(INPUT, { acceptUncertain: true })
		expect(h.machine().step).toBe("mined")
		release()
		await expect(checking).resolves.toBeNull()
		expect([h.machine().step, h.machine().failure]).toEqual(["mined", null])
		// Had the stale answer been remembered, the note would refuse this as IN_FLIGHT.
		await h.submit(INPUT, { acceptUncertain: true })
		expect(h.session.submit).toHaveBeenCalledTimes(2)
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

	test.each([
		["dropped claim", async (): Promise<Sent> => ({ txHash: "0xdd", status: "dropped" }), "0xdd"],
		[
			"claim unanswered after the handoff",
			async (): Promise<Sent> => {
				throw new Error("receipt lookup failed")
			},
			null,
		],
	] as const)("a %s stays pending and is never sent again", async (_name, claim, txHash) => {
		const h = harness({ claim })
		h.atClaimable()
		await h.claim()
		expect([h.machine().step, h.machine().phase, h.machine().claimTx]).toEqual(["claiming", "pending", txHash])
		await h.claim()
		expect(h.session.claim).toHaveBeenCalledTimes(1)
	})

	test("a send whose wallet request is still out when the session changes blocks its note under the next one until it settles", async () => {
		const h = harness()
		h.hold("wallet")
		const first = h.submit()
		await h.reached("wallet")
		h.newSession()
		const second = h.submit(INPUT, { acceptUncertain: true })
		await new Promise((r) => setTimeout(r, 0))
		expect(h.sent).toEqual(["eth_sendTransaction"])
		h.open("wallet")
		await Promise.all([first, second])
		await h.submit(INPUT, { acceptUncertain: true })
		expect(h.sent).toEqual(["eth_sendTransaction", "eth_sendTransaction"])
	})

	test("a claim left pending when the session changes reopens as pending and is never sent again", async () => {
		const h = harness({ claim: async (): Promise<Sent> => ({ txHash: "0xdd", status: "dropped" }) })
		h.atClaimable()
		await h.claim()
		h.newSession()
		h.atClaimable()
		await h.follow(CLAIMABLE)
		expect([h.machine().phase, h.machine().claimTx]).toEqual(["pending", "0xdd"])
		await h.claim()
		expect(h.session.claim).toHaveBeenCalledTimes(1)
	})
})
