// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { RECOVERY_PLAIN, RECOVERY_PRECISE } from "../../app/copy"
import { messageOf } from "../../data/errors"
import { clickSignIn, connectAztec, renderApp } from "../../test-utils/app"

afterEach(cleanup)

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>("button", { name })

describe("connect", () => {
	test("a wallet on another chain is asked to switch and never to sign; a failed sign-in says what to do; signing in again works", async () => {
		const app = renderApp()
		await waitFor(() => expect(button("Sign in with Ethereum").disabled).toBe(false))
		act(() => app.control.setL1Chain(1))
		await screen.findByText("Your Ethereum wallet is on another network")
		expect(button("Sign in with Ethereum").disabled).toBe(true)
		act(() => app.control.setL1Chain(31337))
		app.control.failNext("open", "RPC_FAILED")
		await clickSignIn(app.user)
		await screen.findByText(messageOf("RPC_FAILED"))
		await clickSignIn(app.user, "Sign in again")
		await screen.findByText("Notes by label")
	})

	test("an account with no pool notes gets an empty state naming both causes and the pool app", async () => {
		const app = renderApp()
		act(() => app.control.selectL1Account("sender"))
		await clickSignIn(app.user)
		await screen.findByText("No pool notes found for this account")
		screen.getByText(/has not set up a pool account yet, or it set one up under another app version/)
		screen.getByText(/Deposit through the pool app/)
	})

	test("a declined grant hides balances and disables the token actions with a reason; connecting again with the grant restores them", async () => {
		const app = renderApp()
		app.control.declineNextGrant()
		await connectAztec(app.user)
		await screen.findByText("Your balances are hidden from this page")
		const pub = within(screen.getByTestId("public-row"))
		expect(pub.getByRole<HTMLButtonElement>("button", { name: "Shield" }).disabled).toBe(true)
		expect(pub.getAllByText(messageOf("NOT_GRANTED")).length).toBeGreaterThan(0)
		await app.user.click(screen.getByTestId("disconnect-button"))
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		await waitFor(() =>
			expect(within(screen.getByTestId("public-row")).getByRole<HTMLButtonElement>("button", { name: "Shield" }).disabled).toBe(
				false,
			),
		)
	})
})

describe("the shell", () => {
	test("the page carries the plain recovery sentence and Details the precise one; Forget this device signs out and deletes this device's records", async () => {
		const app = renderApp({ patch: (s) => ({ ...s, sessions: { ...s.sessions, forget: vi.fn(s.sessions.forget) } }) })
		screen.getByText(RECOVERY_PLAIN)
		await clickSignIn(app.user)
		await screen.findByText("Notes by label")
		await app.user.click(button("Details"))
		expect(screen.getByTestId("recovery-precise").textContent).toBe(RECOVERY_PRECISE.replaceAll("`", ""))
		await app.user.click(button("Forget this device"))
		await app.user.click(button("Forget"))
		await waitFor(() => expect(app.source.sessions.forget).toHaveBeenCalledOnce())
		await app.user.keyboard("{Escape}")
		await screen.findByRole("button", { name: "Sign in with Ethereum" })
	})
})
