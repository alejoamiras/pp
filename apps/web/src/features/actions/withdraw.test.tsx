// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { messageOf } from "../../data/errors"
import { ACCOUNTS, LABELS } from "../../data/fixtures/seed"
import type { AztecPort } from "../../data/ports"
import { connectAztec, labelRow, renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

const WITHDRAW = "Withdraw to Ethereum"
const usdc = (n: number) => BigInt(Math.round(n * 1e6))
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled
/** The visible reason a disabled button is tied to. */
const reasonOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null

async function openWithdraw(app: ReturnType<typeof renderApp>) {
	await screen.findAllByTestId("label-row")
	await app.user.click(labelRow(LABELS.active).getByRole("button", { name: WITHDRAW }))
	return within(await screen.findByTestId("action-dialog"))
}

/** Types the payee over the signed-in account the field starts with. */
async function payTo(app: ReturnType<typeof renderApp>, dialog: ReturnType<typeof within>) {
	const payee = dialog.getByLabelText("Payee on Ethereum")
	await app.user.clear(payee)
	await app.user.type(payee, ACCOUNTS.sender)
}

async function review(app: ReturnType<typeof renderApp>, dialog: ReturnType<typeof within>, amount: string) {
	await app.user.type(dialog.getByLabelText(/Amount/), amount)
	await payTo(app, dialog)
	await app.user.click(await dialog.findByRole("button", { name: "Review" }))
	return within(await dialog.findByTestId("exit-review"))
}

describe("the label's withdrawal to Ethereum", () => {
	test("the confirm shows the exact amount and what is public; the payee is on Exits once the wallet holds the send", async () => {
		const asked: string[] = []
		const calls: Parameters<AztecPort["unshieldAndExit"]>[1][] = []
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: {
					...s.aztec,
					unshieldAndExit: async (_from, a, on) => {
						calls.push(a)
						on.handoff()
						return { status: "unconfirmed" as const }
					},
				},
				exits: {
					...s.exits,
					tickets: async (payee) => {
						asked.push(payee)
						return []
					},
				},
			}),
		})
		await signIn(app.user)
		await connectAztec(app.user)
		const dialog = await openWithdraw(app)
		const confirm = await review(app, dialog, "1.005")
		confirm.getByText(ACCOUNTS.sender)
		confirm.getByText("1.005 USDC")
		expect(confirm.getByTestId("exit-public").textContent).toBe(
			"Public: your Aztec account, the payee and the amount. Not shown: the label.",
		)
		await app.user.click(confirm.getByRole("button", { name: WITHDRAW }))
		await dialog.findByText(messageOf("UNKNOWN"))
		expect(calls).toEqual([{ payee: ACCOUNTS.sender, amount: usdc(1.005), label: LABELS.active, origin: 0 }])
		await app.user.click(dialog.getByRole("button", { name: "Cancel" }))
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await waitFor(() => expect(asked).toContain(ACCOUNTS.sender))
	})

	test("takes at most the label's 8 largest notes, read again under the send lock", async () => {
		const nine = [5, 5, 5, 5, 5, 5, 5, 4, 1].map(usdc)
		let notes = nine
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: {
					...s.aztec,
					notesByLabel: async (owner, label) => (label === LABELS.active ? notes : s.aztec.notesByLabel(owner, label)),
				},
			}),
		})
		await connectAztec(app.user)
		const dialog = await openWithdraw(app)
		await dialog.findByText(/^One transaction spends at most this label's 8 largest notes: up to 39 USDC\./)
		await app.user.type(dialog.getByLabelText(/Amount/), "40")
		await payTo(app, dialog)
		expect(disabled(dialog.getByRole("button", { name: "Review" }))).toBe(true)
		await app.user.clear(dialog.getByLabelText(/Amount/))
		await app.user.type(dialog.getByLabelText(/Amount/), "39")
		await app.user.click(dialog.getByRole("button", { name: "Review" }))
		const confirm = within(dialog.getByTestId("exit-review"))
		notes = nine.slice(0, 3)
		const sent = app.control.state().sent.aztec
		await app.user.click(confirm.getByRole("button", { name: WITHDRAW }))
		await dialog.findByText(messageOf("OVER_NOTE_CAP"))
		expect(app.control.state().sent.aztec).toBe(sent)
	})

	test("a reconnect while the send is being prepared sends nothing", async () => {
		let hold = false
		const held: (() => void)[] = []
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: {
					...s.aztec,
					notesByLabel: (...a: Parameters<typeof s.aztec.notesByLabel>) =>
						hold ? new Promise((r) => held.push(() => r(s.aztec.notesByLabel(...a)))) : s.aztec.notesByLabel(...a),
				},
			}),
		})
		await connectAztec(app.user)
		const dialog = await openWithdraw(app)
		const confirm = await review(app, dialog, "5")
		hold = true
		await app.user.click(confirm.getByRole("button", { name: WITHDRAW }))
		act(() => app.control.disconnectAztec())
		await connectAztec(app.user)
		await act(async () => {
			for (const release of held.splice(0)) release()
		})
		expect(app.control.state().sent.aztec).toBe(0)
		expect(app.control.state().exits).toEqual([])
	})

	test("a revert says the fee was paid and holds change-making spends, the withdrawal included, until its block is final", async () => {
		const app = renderApp()
		await connectAztec(app.user)
		app.control.failNext("unshieldAndExit", "REVERTED")
		const dialog = await openWithdraw(app)
		const confirm = await review(app, dialog, "5")
		await app.user.click(confirm.getByRole("button", { name: WITHDRAW }))
		await dialog.findByText(messageOf("WITHDRAW_REVERTED"))
		await app.user.click(dialog.getByRole("button", { name: "Cancel" }))
		await waitFor(() => labelRow(LABELS.active).getByText(messageOf("WAIT_FINALITY")))
		const row = labelRow(LABELS.active)
		expect(["Send privately", "Unshield", WITHDRAW].map((name) => disabled(row.getByRole("button", { name })))).toEqual([
			true,
			true,
			true,
		])
		expect(disabled(row.getByRole("button", { name: /Leave to Ethereum/ }))).toBe(false)
		expect(app.control.state().exits).toEqual([])
	})

	test("the button says the label's reason before the stage's, which closes it where exit_public is not deployed", async () => {
		const app = renderApp({ patch: (s) => ({ ...s, deployment: { ...s.deployment, stage: "2c" } }) })
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const active = labelRow(LABELS.active)
		expect(disabled(active.getByRole("button", { name: "Unshield" }))).toBe(false)
		expect(reasonOf(active.getByRole("button", { name: WITHDRAW }))).toBe(messageOf("STAGE_UNSUPPORTED"))
		const revoked = labelRow(LABELS.revoked)
		const unshield = reasonOf(revoked.getByRole("button", { name: "Unshield" }))
		expect(unshield).not.toBeNull()
		expect(reasonOf(revoked.getByRole("button", { name: WITHDRAW }))).toBe(unshield)
	})
})
