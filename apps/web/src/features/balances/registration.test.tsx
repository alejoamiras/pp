// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { messageOf } from "../../data/errors"
import { clickSignIn, renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

const step = () => within(screen.getByTestId("register-step"))
const registerButton = () => step().getByRole<HTMLButtonElement>("button", { name: "Register" })

function unregistered() {
	const app = renderApp()
	app.control.unregisterOwner()
	return app
}

describe("the pool registration step", () => {
	test("is not offered to a registered owner", async () => {
		const { user } = renderApp()
		await signIn(user)
		expect(screen.queryByTestId("register-step")).toBeNull()
	})

	test("stands in for the notes until both keys are set, then shows them", async () => {
		const { user, control } = unregistered()
		await clickSignIn(user)
		expect((await screen.findByTestId("register-step")).dataset.next).toBe("setAuthPolicy")
		expect(screen.queryByText("Notes by label")).toBeNull()
		await user.click(registerButton())
		await screen.findByText("Notes by label")
		expect(control.state().sent.l1).toBe(2)
	})

	test("reads the wallet's no as a refusal that set nothing, and resumes from the chain", async () => {
		const { user, control } = unregistered()
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		control.failNext("send", "REJECTED")
		await user.click(registerButton())
		const failed = await screen.findByTestId("register-failed")
		expect(failed.dataset.code).toBe("WALLET_REJECTED")
		expect(failed.textContent).toContain(messageOf("WALLET_REJECTED"))
		expect(control.state().sent.l1).toBe(0)
		await user.click(registerButton())
		await screen.findByText("Notes by label")
		expect(control.state().sent.l1).toBe(2)
	})

	test("stays blocked after leaving Balances while the wallet holds the call, so a second run cannot start", async () => {
		const { user, control } = unregistered()
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		control.hangNext("send")
		await user.click(registerButton())
		await user.click(screen.getByRole("button", { name: "Exits" }))
		await user.click(screen.getByRole("button", { name: "Balances" }))
		await waitFor(() => expect(registerButton().disabled).toBe(true))
		expect(step().getByText("Your Ethereum wallet has the registration.")).toBeTruthy()
	})

	test("reads the keystore again after a sign-out, never the answer from before it", async () => {
		const { user, control } = renderApp()
		await signIn(user)
		await user.click(screen.getByRole("button", { name: "Sign out" }))
		control.unregisterOwner()
		control.hangNext("register")
		await clickSignIn(user)
		await screen.findByText("Checking your pool registration…")
		expect(screen.queryByText("Notes by label")).toBeNull()
	})

	test("shows a sign-in afresh, without the outcome of a run from before a sign-out", async () => {
		const { user, control } = unregistered()
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		control.failNext("send", "REJECTED")
		await user.click(registerButton())
		await screen.findByTestId("register-failed")
		await user.click(screen.getByRole("button", { name: "Sign out" }))
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		expect(screen.queryByTestId("register-failed")).toBeNull()
	})

	test("stays blocked across a sign-out and back while the wallet still holds the call", async () => {
		const { user, control } = unregistered()
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		control.hangNext("send")
		await user.click(registerButton())
		await user.click(screen.getByRole("button", { name: "Sign out" }))
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		expect(registerButton().disabled).toBe(true)
		expect(step().getByText("Your Ethereum wallet has the registration.")).toBeTruthy()
	})

	test("keeps each account's keys apart", async () => {
		const { user, control } = unregistered()
		act(() => control.selectL1Account("sender"))
		await clickSignIn(user)
		await screen.findByText(/This account is registered with the pool/)
		expect(screen.queryByTestId("register-step")).toBeNull()
	})

	test("is closed while another account is selected, and sends nothing", async () => {
		const { user, control } = unregistered()
		await clickSignIn(user)
		await screen.findByTestId("register-step")
		act(() => control.selectL1Account("sender"))
		await waitFor(() => expect(registerButton().disabled).toBe(true))
		expect(step().getByText(messageOf("REGISTER_FROM_OWNER"))).toBeTruthy()
		expect(control.state().sent.l1).toBe(0)
	})
})
