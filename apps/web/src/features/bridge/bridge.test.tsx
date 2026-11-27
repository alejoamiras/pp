// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { messageOf, UNCERTAIN_WORST_CASE } from "../../data/errors"
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

/** Records the options of every `Session.submit`, so a test sees what reached the session. */
function submitsOf(): { options: unknown[]; patch(s: DataSource): DataSource } {
	const options: unknown[] = []
	return {
		options,
		patch: (s) => ({
			...s,
			sessions: {
				...s.sessions,
				async open(a) {
					const session = await s.sessions.open(a)
					return {
						...session,
						submit: (p, attempt, on, o) => {
							options.push(o)
							return session.submit(p, attempt, on, o)
						},
					}
				},
			},
		}),
	}
}

/** A second page load over `store`, signed in as the owner with Aztec connected and the sender selected. */
async function reload(store: ReturnType<typeof memoryStore>) {
	const app = renderApp({ store })
	act(() => app.control.selectL1Account("owner"))
	await signIn(app.user)
	await connectAztec(app.user)
	act(() => app.control.selectL1Account("sender"))
	return app
}

describe("the bridge screen", () => {
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
