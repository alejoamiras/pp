// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { getAddress } from "viem"
import { afterEach, describe, expect, test } from "vitest"
import { BridgeFailure, messageOf, UNCERTAIN_WORST_CASE } from "../../data/errors"
import type { Attempt } from "../../data/ports"
import type { DataSource } from "../../data/source"
import { connectAztec, memoryStore, noteRow, renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

/** The seeded approved note: 100 of the token under one label. */
const NOTE = 0x1001n
/** The Ethereum transaction mined; whether Aztec has a block past it yet depends on the blocks already advanced. */
const landed = () =>
	waitFor(() => expect(["mined", "claimable"]).toContain(screen.getByTestId("bridge-screen").dataset.step), { timeout: 3_000 })

/** Owner signed in, Aztec connected, the separate sender selected, 70 typed into the 100 note's bridge form. */
async function openBridge(store = memoryStore(), patch?: (s: DataSource) => DataSource) {
	const app = renderApp({ store, ...(patch ? { patch } : {}) })
	await signIn(app.user)
	await connectAztec(app.user)
	act(() => app.control.selectL1Account("sender"))
	await app.user.click(noteRow(NOTE).getByRole("button", { name: "Bridge to Aztec" }))
	await app.user.type(screen.getByLabelText(/Amount to bridge/), "70")
	return app
}

async function submit(app: Awaited<ReturnType<typeof openBridge>>) {
	const button = () => within(screen.getByTestId("bridge-form")).getByRole<HTMLButtonElement>("button", { name: "Bridge to Aztec" })
	await waitFor(() => expect(button().disabled).toBe(false))
	await app.user.click(button())
}

/** What reached the session: the options of every `submit`, and how many proofs and journal reads. */
function submitsOf() {
	const seen = {
		options: [] as unknown[],
		proves: 0,
		reads: 0,
		patch: (s: DataSource): DataSource => ({
			...s,
			sessions: {
				...s.sessions,
				async open(a) {
					const session = await s.sessions.open(a)
					return {
						...session,
						prove: (attempt) => {
							seen.proves++
							return session.prove(attempt)
						},
						records: () => {
							seen.reads++
							return session.records()
						},
						submit: (p, attempt, on, o) => {
							seen.options.push(o)
							return session.submit(p, attempt, on, o)
						},
					}
				},
			},
		}),
	}
	return seen
}

/** Clicks Check again in `scope` and lets what it started settle: it reads the journal at least once. */
async function checkAgain(
	app: Pick<Awaited<ReturnType<typeof openBridge>>, "user">,
	seen: { reads: number },
	scope: Pick<typeof screen, "getByRole"> = screen,
) {
	const before = seen.reads
	await app.user.click(scope.getByRole("button", { name: "Check again" }))
	await waitFor(() => expect(seen.reads).toBeGreaterThan(before))
	await act(() => new Promise((r) => setTimeout(r, 20)))
}

/** A second page load over `store`, signed in as the owner with Aztec connected and the sender selected. */
async function reload(store: ReturnType<typeof memoryStore>, patch?: (s: DataSource) => DataSource) {
	const app = renderApp({ store, ...(patch ? { patch } : {}) })
	act(() => app.control.selectL1Account("owner"))
	await signIn(app.user)
	await connectAztec(app.user)
	act(() => app.control.selectL1Account("sender"))
	return app
}

describe("the bridge screen", () => {
	test("with the owner selected, a local-stack build offers its dev account, and a bridge sends from it once its check passes", async () => {
		const DEV = getAddress("0x00000000000000000000000000000000000000aa")
		const checks = [() => Promise.reject(new BridgeFailure("DEPLOYMENT_MISMATCH")), () => Promise.resolve()]
		const attempts: Attempt[] = []
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: { ...s.l1, demo: { address: DEV, ready: () => (checks.shift() as () => Promise<void>)() } },
				sessions: {
					...s.sessions,
					open: async (a) => ({
						...(await s.sessions.open(a)),
						submit: (_p, attempt) => {
							attempts.push(attempt)
							return new Promise(() => {})
						},
					}),
				},
			}),
		})
		await signIn(app.user)
		await connectAztec(app.user)
		await app.user.click(noteRow(NOTE).getByRole("button", { name: "Bridge to Aztec" }))
		await app.user.type(screen.getByLabelText(/Amount to bridge/), "70")
		const offer = () => screen.getByRole("button", { name: "Send from the local dev account" })
		await app.user.click(offer())
		await screen.findByText(messageOf("DEPLOYMENT_MISMATCH"))
		expect(screen.queryByTestId("demo-sender")).toBeNull()
		await app.user.click(offer())
		expect((await screen.findByTestId("demo-sender")).textContent).toContain(DEV)
		await submit(app)
		await waitFor(() => expect(attempts.map((a) => a.sender)).toEqual([DEV]))
	})

	test("bridges to claimed on the virtual clock, saying which root a re-proof followed", async () => {
		const app = await openBridge()
		app.control.reproveNext("ASP_ROOT_STALE")
		await submit(app)
		await screen.findByText("Mined: waiting for Aztec to include the message")
		screen.getByText("A root changed (allow list); proving again.")
		screen.getByText("Same label on both sides")
		act(() => app.control.advance(6))
		await screen.findByText("Next, you")
		await app.user.click(screen.getByRole("button", { name: "Claim on Aztec" }))
		await screen.findByText("The funds are on Aztec under the same label.")
		expect(app.control.state().bridges).toMatchObject([{ state: "claimed", amount: "70000000" }])
		expect(app.control.state().sent).toEqual({ l1: 1, aztec: 1 })
	})

	test("shows the proving pause first; a prove that hangs stops at 60 s of chain time with nothing sent, and Prove again recovers", async () => {
		const app = await openBridge()
		app.control.hangNext("prove")
		await submit(app)
		await screen.findByText("Proving — the page may pause for a few seconds; the first use downloads about 21 MB")
		act(() => app.control.advance(5))
		await screen.findByText(messageOf("PROVE_TIMEOUT"))
		expect(app.control.state().sent.l1).toBe(0)
		await app.user.click(screen.getByRole("button", { name: "Prove again" }))
		await landed()
	})

	test("a revert says the note is unspent, and Prove again sends a new attempt", async () => {
		const app = await openBridge()
		app.control.failNext("send", "REVERTED")
		await submit(app)
		await screen.findByText(messageOf("REVERTED"))
		await app.user.click(screen.getByRole("button", { name: "Prove again" }))
		await landed()
		expect(app.control.state().sent.l1).toBe(2)
	})

	test("a wallet rejection sends nothing, drops the journal record, and Submit works again", async () => {
		const app = await openBridge()
		app.control.failNext("send", "REJECTED")
		await submit(app)
		await screen.findByText(messageOf("WALLET_REJECTED"))
		expect(app.control.state()).toMatchObject({ sent: { l1: 0 }, bridges: [] })
		await submit(app)
		await landed()
	})

	test("UNCERTAIN states the worst case; Check again answers from the journal with no submit, Send again sends with the override", async () => {
		const submits = submitsOf()
		const app = await openBridge(memoryStore(), submits.patch)
		app.control.failNext("submit", "UNCERTAIN")
		await submit(app)
		await screen.findByText("We can't see your transaction yet")
		screen.getByText(UNCERTAIN_WORST_CASE)
		expect(screen.queryByRole("button", { name: "Prove again" })).toBeNull()
		await app.user.click(screen.getByRole("button", { name: "Check again" }))
		await screen.findByText("We can't see your transaction yet")
		expect(submits.options).toEqual([undefined])
		expect(app.control.state().sent.l1).toBe(0)
		await app.user.click(screen.getByRole("button", { name: "Send again" }))
		await landed()
		expect(submits.options.at(-1)).toEqual({ acceptUncertain: true })
	})

	test("a reload with an unanswered Ethereum wallet and no hash shows UNCERTAIN on the note, and Send again bridges it", async () => {
		const store = memoryStore()
		const first = await openBridge(store)
		first.control.hangNext("send")
		await submit(first)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		first.unmount()

		const second = await reload(store)
		await waitFor(() => noteRow(NOTE).getByText("We can't see your transaction yet"))
		noteRow(NOTE).getByText(UNCERTAIN_WORST_CASE)
		noteRow(NOTE).getByRole("button", { name: "Check again" })
		expect(noteRow(NOTE).queryByRole("button", { name: "Bridge to Aztec" })).toBeNull()
		await waitFor(() => expect(noteRow(NOTE).getByRole<HTMLButtonElement>("button", { name: "Send again" }).disabled).toBe(false))
		await second.user.click(noteRow(NOTE).getByRole("button", { name: "Send again" }))
		await landed()
		expect(second.control.state().sent.l1).toBe(1)
	})

	test("Check again after a lost send reads the journal and the chain before proving, so a failing prover cannot hide it", async () => {
		const submits = submitsOf()
		const app = await openBridge(memoryStore(), submits.patch)
		app.control.failNext("send", "LOST")
		await submit(app)
		await screen.findByText("We can't see your transaction yet")
		app.control.failNext("prove", "PROVE_FAILED")
		await app.user.click(screen.getByRole("button", { name: "Check again" }))
		await screen.findByText("We can't see your transaction yet")
		expect(screen.queryByText(messageOf("PROVE_FAILED"))).toBeNull()
		expect(submits.options).toEqual([undefined])
		// The prove fault is still armed: Send again is the first to prove.
		await app.user.click(screen.getByRole("button", { name: "Send again" }))
		await screen.findByText(messageOf("PROVE_FAILED"))
	})

	test("Check again only reads: with the journal cleared in another tab, it proves and sends nothing and still shows UNCERTAIN", async () => {
		const seen = submitsOf()
		const app = await openBridge(memoryStore(), seen.patch)
		app.control.failNext("send", "LOST")
		await submit(app)
		await screen.findByText("We can't see your transaction yet")
		await app.source.sessions.forget()
		await checkAgain(app, seen)
		expect([seen.proves, seen.options.length, app.control.state().sent.l1]).toEqual([1, 1, 0])
		screen.getByText("We can't see your transaction yet")
		await app.user.click(screen.getByRole("button", { name: "Send again" }))
		await landed()
		expect(seen.options.at(-1)).toEqual({ acceptUncertain: true })
	})

	test("Check again on a reloaded note only reads, even once the journal is cleared in another tab", async () => {
		const store = memoryStore()
		const first = await openBridge(store)
		first.control.hangNext("send")
		await submit(first)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		first.unmount()

		const seen = submitsOf()
		const second = await reload(store, seen.patch)
		await waitFor(() => noteRow(NOTE).getByText("We can't see your transaction yet"))
		await second.source.sessions.forget()
		await checkAgain(second, seen, noteRow(NOTE))
		expect([seen.proves, seen.options.length, second.control.state().sent.l1]).toEqual([0, 0, 0])
		await screen.findByText("We can't see your transaction yet")
	})

	test("a resend that reverts leaves the earlier unconfirmed send on the note, with its controls", async () => {
		const app = await openBridge()
		app.control.failNext("send", "LOST")
		await submit(app)
		await screen.findByText("We can't see your transaction yet")
		app.control.failNext("send", "REVERTED")
		await app.user.click(screen.getByRole("button", { name: "Send again" }))
		await screen.findByText(messageOf("REVERTED"))
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		await waitFor(() => noteRow(NOTE).getByText("We can't see your transaction yet"))
		noteRow(NOTE).getByRole("button", { name: "Check again" })
		noteRow(NOTE).getByRole("button", { name: "Send again" })
	})

	test("a dropped claim reopened after another bridge still shows pending, with no Claim button", async () => {
		const app = await openBridge()
		await submit(app)
		await landed()
		act(() => app.control.advance(6))
		await screen.findByText("Next, you")
		app.control.failNext("claim", "DROPPED")
		await app.user.click(screen.getByRole("button", { name: "Claim on Aztec" }))
		await screen.findByText("Aztec has not included the claim yet")
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		const [change] = await screen.findAllByRole("button", { name: "Bridge to Aztec" })
		await app.user.click(change as HTMLElement)
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		await app.user.click(within(await screen.findByTestId("bridge-record")).getByRole("button", { name: "Open" }))
		await screen.findByText("Aztec has not included the claim yet")
		expect(screen.queryByRole("button", { name: "Claim on Aztec" })).toBeNull()
	})

	test("this page's own send waiting on the wallet shows on Balances as in progress with no action, and keeps its screen", async () => {
		const app = await openBridge()
		app.control.hangNext("send")
		await submit(app)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		await waitFor(() => noteRow(NOTE).getByText("Bridge in progress"))
		expect(noteRow(NOTE).queryByText("We can't see your transaction yet")).toBeNull()
		expect(noteRow(NOTE).queryAllByRole("button")).toEqual([])
		await app.user.click(screen.getByRole("button", { name: "Back to the bridge in progress" }))
		screen.getByText("Sent: waiting for the Ethereum transaction to be mined")
	})

	test("a send still waiting on the wallet across a sign-out and back stays in progress, and nothing more is sent", async () => {
		const app = await openBridge()
		app.control.hangNext("send")
		await submit(app)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		await app.user.click(screen.getByRole("button", { name: "Sign out" }))
		act(() => app.control.selectL1Account("owner"))
		await signIn(app.user)
		act(() => app.control.selectL1Account("sender"))
		await waitFor(() => noteRow(NOTE).getByText("Bridge in progress"))
		expect(noteRow(NOTE).queryAllByRole("button")).toEqual([])
		expect(app.control.state().sent.l1).toBe(0)
	})

	test("while the bridge's wallet request is unanswered, opening an earlier bridge is refused with a reason", async () => {
		const app = await openBridge()
		await submit(app)
		await landed()
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		const [change] = await screen.findAllByRole("button", { name: "Bridge to Aztec" })
		await app.user.click(change as HTMLElement)
		await app.user.type(screen.getByLabelText(/Amount to bridge/), "10")
		app.control.hangNext("send")
		await submit(app)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		await app.user.click(screen.getByRole("button", { name: "Back to balances" }))
		const open = within(await screen.findByTestId("bridge-record")).getByRole<HTMLButtonElement>("button", { name: "Open" })
		expect(open.disabled).toBe(true)
		expect(document.getElementById(open.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
			"Your Ethereum wallet has not answered the bridge in progress yet.",
		)
		await app.user.click(screen.getByRole("button", { name: "Back to the bridge in progress" }))
		screen.getByText("Sent: waiting for the Ethereum transaction to be mined")
	})

	test("a send pending at the RPC shows its hash on the bridge screen while it waits, with no send offered", async () => {
		const app = await openBridge()
		app.control.failNext("send", "PENDING")
		await submit(app)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		await waitFor(() => {
			const hash = app.control.state().bridges[0]?.l1TxHash
			expect(hash).toBeDefined()
			expect(within(screen.getByTestId("bridge-screen")).getByTestId("pending-tx").textContent).toBe(hash)
		})
		for (const name of ["Send again", "Prove again", "Check again"]) expect(screen.queryByRole("button", { name })).toBeNull()
	})

	test("a record whose transaction is pending at the RPC shows IN_FLIGHT with its hash and offers no send", async () => {
		const store = memoryStore()
		const first = await openBridge(store)
		first.control.failNext("send", "PENDING")
		await submit(first)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		const hash = first.control.state().bridges[0]?.l1TxHash
		first.unmount()

		await reload(store)
		await waitFor(() => noteRow(NOTE).getByText("Waiting for your Ethereum transaction"))
		expect(noteRow(NOTE).getByTestId("pending-tx").textContent).toBe(hash)
		expect(noteRow(NOTE).queryAllByRole("button")).toEqual([])
	})

	test("a mined bridge whose journal was forgotten comes back from the chain for the connected account", async () => {
		const store = memoryStore()
		const first = await openBridge(store)
		await submit(first)
		await landed()
		await first.source.sessions.forget()
		first.unmount()

		await reload(store)
		await screen.findByTestId("bridge-record")
	})
})
