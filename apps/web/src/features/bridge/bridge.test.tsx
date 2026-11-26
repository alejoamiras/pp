// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { messageOf } from "../../data/errors"
import { connectAztec, memoryStore, noteRow, renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

/** The seeded approved note: 100 of the token under one label. */
const NOTE = 0x1001n
/** The Ethereum transaction mined; whether Aztec has a block past it yet depends on the blocks already advanced. */
const landed = () =>
	waitFor(() => expect(["mined", "claimable"]).toContain(screen.getByTestId("bridge-screen").dataset.step), { timeout: 3_000 })

/** Owner signed in, Aztec connected, the separate sender selected, 70 typed into the 100 note's bridge form. */
async function openBridge(store = memoryStore()) {
	const app = renderApp({ store })
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

	test("UNCERTAIN offers only an explicit Send again, warning that a second transaction may revert and cost gas", async () => {
		const app = await openBridge()
		app.control.failNext("submit", "UNCERTAIN")
		await submit(app)
		await screen.findByText("We can't see your transaction yet")
		screen.getByText("A second transaction may revert and cost gas if the first one lands.")
		expect(screen.queryByRole("button", { name: "Prove again" })).toBeNull()
		await app.user.click(screen.getByRole("button", { name: "Send again" }))
		await landed()
	})

	test("a reload with an unanswered Ethereum wallet shows may be in flight and offers no second bridge of that note", async () => {
		const store = memoryStore()
		const first = await openBridge(store)
		first.control.hangNext("send")
		await submit(first)
		await screen.findByText("Sent: waiting for the Ethereum transaction to be mined")
		first.unmount()

		const second = renderApp({ store })
		act(() => second.control.selectL1Account("owner"))
		await signIn(second.user)
		const row = noteRow(NOTE)
		row.getByText("A bridge from this note may be in flight")
		expect(row.queryByRole("button", { name: "Bridge to Aztec" })).toBeNull()
		expect(second.control.state().sent.l1).toBe(0)
	})
})
