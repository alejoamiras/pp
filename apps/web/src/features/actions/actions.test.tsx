// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import type { AztecAddress } from "../../data/a7"
import { messageOf, PAYEE_MESSAGES } from "../../data/errors"
import { ACCOUNTS, LABELS } from "../../data/fixtures/seed"
import { connectAztec, labelRow, renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

const OTHER = `0x${"2d".repeat(32)}` as AztecAddress
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled

async function openDialog(app: ReturnType<typeof renderApp>, label: bigint, action: string | RegExp) {
	await app.user.click(labelRow(label).getByRole("button", { name: action }))
	return within(await screen.findByTestId("action-dialog"))
}

describe("the action dialogs", () => {
	test("payee refusals and a note set that changed under a confirmed ragequit send nothing", async () => {
		const app = renderApp()
		await signIn(app.user)
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, /Leave to Ethereum/)
		dialog.getByText("This exit is public")
		await app.user.click(await dialog.findByLabelText(/40\.00 USDC/))
		const payee = dialog.getByLabelText("Payee on Ethereum")
		const refusals = [
			["0x0000000000000000000000000000000000000000", PAYEE_MESSAGES.zero],
			[app.source.deployment.portal, PAYEE_MESSAGES.portal],
			[ACCOUNTS.owner.toLowerCase(), PAYEE_MESSAGES.checksum],
		] as const
		for (const [text, message] of refusals) {
			await app.user.clear(payee)
			await app.user.type(payee, text)
			dialog.getByText(message)
			expect(disabled(dialog.getByRole("button", { name: "Review" }))).toBe(true)
		}
		await app.user.clear(payee)
		await app.user.type(payee, ACCOUNTS.owner)
		await app.user.click(dialog.getByRole("button", { name: "Review" }))
		within(dialog.getByTestId("exit-review")).getByText(ACCOUNTS.owner)
		dialog.getByText("This payee is your pool owner's address")

		// Elsewhere, 15 leaves the label: its notes become 15 and 10, and 40 is no longer a sum of whole notes.
		await act(() =>
			app.source.aztec.transferPrivate(ACCOUNTS.aztec, { to: OTHER, amount: 15_000_000n, label: LABELS.active, origin: 0 }),
		)
		const sent = app.control.state().sent.aztec
		await app.user.click(dialog.getByRole("button", { name: /Leave to Ethereum/ }))
		await dialog.findByText(messageOf("NO_EXACT_CHUNKS"))
		expect(app.control.state().sent.aztec).toBe(sent)
		expect(app.control.state().exits).toEqual([])
	})

	test("an unshield revert says the fee was paid; change-making spends wait for finality while ragequit stays open", async () => {
		const app = renderApp()
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		app.control.failNext("unshield", "REVERTED")
		const dialog = await openDialog(app, LABELS.active, "Unshield")
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		await app.user.click(dialog.getByRole("button", { name: "Unshield" }))
		await dialog.findByText(messageOf("UNSHIELD_REVERTED"))
		await app.user.click(dialog.getByRole("button", { name: "Cancel" }))

		await waitFor(() => labelRow(LABELS.active).getByText(messageOf("WAIT_FINALITY")))
		const row = labelRow(LABELS.active)
		expect([
			disabled(row.getByRole("button", { name: "Send privately" })),
			disabled(row.getByRole("button", { name: "Unshield" })),
		]).toEqual([true, true])
		expect(disabled(row.getByRole("button", { name: /Leave to Ethereum/ }))).toBe(false)

		act(() => app.control.advance(12))
		await app.user.click(screen.getByRole("button", { name: "Refresh" }))
		await waitFor(() => expect(disabled(labelRow(LABELS.active).getByRole("button", { name: "Send privately" }))).toBe(false))
	})
})
