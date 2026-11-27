import { describe, expect, test, vi } from "vitest"
import type { BridgeRecordView } from "../stack-types"
import { createBridgeDriver, createOutstanding, type LiveContext } from "../bridge-driver"
import { type BridgeMachine, bridgeReducer, initialBridge } from "../bridge-machine"
import { openOwnerSession } from "../chain"
import type { Session } from "../ports"
import { createControl } from "./control"
import { FAKE_SIGNATURE, fixtureL1, selectedAccount } from "./l1"
import { ACCOUNTS, LABELS } from "./seed"
import { fixtureSessions } from "./session"
import { createWorld, type KeyValue } from "./world"

function memoryStore(): KeyValue & { dump(): string } {
	const m = new Map<string, string>()
	return {
		getItem: (k) => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, v),
		removeItem: (k) => void m.delete(k),
		dump: () => [...m.values()].join("\n"),
	}
}

/** One page load over a shared store: the world, its control and the owner's session. */
async function page(store: KeyValue) {
	const world = createWorld({ chainId: 31337, storage: store })
	const l1 = fixtureL1(world)
	const control = createControl(world, { remoteDisconnect: () => {} })
	control.selectL1Account("owner")
	const opened = await openOwnerSession({
		l1,
		sessions: fixtureSessions(world, l1.provider),
		chainId: 31337,
		selected: () => ({ account: selectedAccount(world), chainId: world.s.walletChain }),
		current: () => true,
	})
	if (!opened.ok) throw new Error(opened.code)
	control.selectL1Account("sender")
	const ctx = (): LiveContext => ({
		owner: ACCOUNTS.owner,
		account: ACCOUNTS[world.s.selected],
		chainId: world.s.walletChain,
		deployment: world.deployment.id,
		epoch: 1,
		aztecAccounts: [ACCOUNTS.aztec],
	})
	const driver = createBridgeDriver({
		outstanding: createOutstanding(),
		session: opened.session,
		deployment: world.deployment,
		timer: world.timer,
		frame: async () => {},
		context: ctx,
		canClaim: () => true,
	})
	let m: BridgeMachine = initialBridge
	const dispatch = (e: Parameters<typeof bridgeReducer>[1]) => {
		m = bridgeReducer(m, e)
	}
	return { world, control, session: opened.session as Session, driver, dispatch, machine: () => m }
}

describe("the fixture world", () => {
	test("bridges to claimed on the virtual clock and resumes after a reload mid-bridge", async () => {
		const store = memoryStore()
		const first = await page(store)
		const signal = new AbortController().signal
		const [bridgeable] = await first.session.notes()
		if (!bridgeable) throw new Error("no seeded note")
		const record = await first.driver.submit(
			{ note: bridgeable, amount: 70_000_000n, recipient: ACCOUNTS.aztec },
			first.dispatch,
			signal,
		)
		expect(record?.step).toBe("mined")
		expect(first.control.state().sent.l1).toBe(1)

		const second = await page(store)
		const [resumed] = await second.session.records()
		expect(resumed).toMatchObject({ id: record?.id, step: "mined" })
		const following = second.driver.follow(resumed as BridgeRecordView, second.dispatch, signal)
		second.control.advance(6)
		await following
		const [claimable] = await second.session.records()
		second.dispatch({ type: "record", record: claimable as BridgeRecordView })
		await second.driver.claim(claimable as BridgeRecordView, second.dispatch, signal)
		expect(second.machine().step).toBe("claimed")
		const minted = second.control.state().balances.filter((b) => b.label === LABELS.bridgeable.toString())
		expect(minted).toEqual([{ owner: ACCOUNTS.aztec, label: LABELS.bridgeable.toString(), origin: 0, value: "70000000" }])
		expect(second.control.state().notes.map((n) => [n.value, n.status])).toContainEqual(["30000000", "approved"])
		expect(store.dump()).not.toContain(FAKE_SIGNATURE.slice(2))
	})

	test("a wallet refusal of a resend leaves the journal as it was; a send lost with no code keeps its record", async () => {
		const store = memoryStore()
		const first = await page(store)
		const [bridgeable] = await first.session.notes()
		if (!bridgeable) throw new Error("no seeded note")
		const input = { note: bridgeable, amount: 70_000_000n, recipient: ACCOUNTS.aztec }
		first.control.hangNext("send")
		void first.driver.submit(input, first.dispatch, new AbortController().signal)
		await vi.waitFor(() => expect(first.control.state().bridges).toMatchObject([{ state: "pending" }]))

		const second = await page(store)
		const signal = new AbortController().signal
		const journal = second.control.state().bridges
		second.control.failNext("send", "REJECTED")
		await second.driver.submit(input, second.dispatch, signal, { acceptUncertain: true })
		expect(second.machine().notices.at(-1)).toEqual({ kind: "declined" })
		expect(second.control.state().bridges).toEqual(journal)
		second.control.failNext("send", "LOST")
		await second.driver.submit(input, second.dispatch, signal, { acceptUncertain: true })
		expect(second.machine().failure?.code).toBe("UNCERTAIN")
		expect(second.control.state().bridges).toMatchObject([{ state: "pending" }])
	})

	test("a proof spends once and only under the attempt it was made for", async () => {
		const p = await page(memoryStore())
		const a = Object.freeze({
			seq: 1,
			owner: ACCOUNTS.owner,
			sender: ACCOUNTS.sender,
			recipient: ACCOUNTS.aztec,
			deployment: p.world.deployment.id,
			chainId: 31337,
			epoch: 1,
			note: 0x1001n,
			amount: 1n,
		})
		const on = { reproving: () => {}, handoff: () => {}, sent: () => {} }
		await p.session.preflight(ACCOUNTS.aztec, 1)
		const proved = await p.session.prove(a)
		await expect(p.session.submit(proved, { ...a, seq: 2 }, on)).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
		await expect(p.session.submit(proved, a, on)).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
		expect(p.control.state().sent.l1).toBe(0)
	})

	test("the control checks its inputs and arms one-shot faults", async () => {
		const p = await page(memoryStore())
		expect(() => p.control.failNext("nope" as "prove", "X_Y")).toThrow()
		expect(() => p.control.failNext("prove", "lower case")).toThrow()
		expect(() => p.control.advance(-1)).toThrow()
		p.control.failNext("preflight", "RECIPIENT_NOT_IN_WALLET")
		await expect(p.session.preflight(ACCOUNTS.aztec, 1)).rejects.toMatchObject({ code: "RECIPIENT_NOT_IN_WALLET" })
		await expect(p.session.preflight(ACCOUNTS.aztec, 1)).resolves.toBeUndefined()
	})
})
