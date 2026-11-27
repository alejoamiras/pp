// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import type { Hex } from "viem"
import { afterEach, describe, expect, test, vi } from "vitest"
import { RECOVERY_PLAIN, RECOVERY_PRECISE } from "../../app/copy"
import { messageOf } from "../../data/errors"
import { NETWORK_UNKNOWN } from "./EthereumSignIn"
import { FAKE_SIGNATURE } from "../../data/fixtures/l1"
import { ACCOUNTS } from "../../data/fixtures/seed"
import { shortHex } from "../../ui"
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

	test("Sign in waits for the wallet's network, and an account event re-reads one the first read missed", async () => {
		let reads = 0
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: { ...s.l1, chainId: () => (reads++ === 0 ? Promise.reject(new Error("the wallet is locked")) : s.l1.chainId()) },
			}),
		})
		await waitFor(() => expect(screen.queryByText(messageOf("NO_SENDER"))).toBeNull())
		expect(button("Sign in with Ethereum").disabled).toBe(true)
		screen.getByText(NETWORK_UNKNOWN)
		act(() => app.control.selectL1Account("sender"))
		act(() => app.control.selectL1Account("owner"))
		await clickSignIn(app.user)
		await screen.findByText("Notes by label")
	})

	test("a wallet that has shared no account with this page is asked for one at Sign in, then signs", async () => {
		let shared = false
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: {
					...s.l1,
					accounts: async () => (shared ? s.l1.accounts() : []),
					requestAccounts: vi.fn(async () => {
						shared = true
						return s.l1.accounts()
					}),
				},
			}),
		})
		await clickSignIn(app.user)
		await screen.findByText("Notes by label")
		expect(app.source.l1.requestAccounts).toHaveBeenCalledOnce()
	})

	test("an account event during the request wins: the session's owner is the wallet's selection at signature, not the account shared", async () => {
		let shared = false
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: {
					...s.l1,
					accounts: async () => (shared ? s.l1.accounts() : []),
					requestAccounts: async () => {
						shared = true
						const answer = await s.l1.accounts()
						app.control.selectL1Account("sender")
						return answer
					},
				},
			}),
		})
		await clickSignIn(app.user)
		const pool = within(await screen.findByTestId("pool-panel"))
		await pool.findByText(shortHex(ACCOUNTS.sender))
		expect(pool.queryByText(shortHex(ACCOUNTS.owner))).toBeNull()
	})

	test("Sign in clicked before the first account read lands does not ask a wallet that already shared one", async () => {
		let first = true
		const requestAccounts = vi.fn(async (): Promise<never> => {
			throw Object.assign(new Error("eth_requestAccounts is not supported"), { code: 4200 })
		})
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: {
					...s.l1,
					accounts: () => {
						if (!first) return s.l1.accounts()
						first = false
						return new Promise<never>(() => {})
					},
					requestAccounts,
				},
			}),
		})
		await clickSignIn(app.user)
		await screen.findByText("Notes by label")
		expect(requestAccounts).not.toHaveBeenCalled()
	})

	test("a locked wallet that answers neither an account nor its network can still be asked at Sign in", async () => {
		let unlocked = false
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: {
					...s.l1,
					accounts: async () => (unlocked ? s.l1.accounts() : []),
					chainId: async () => {
						if (!unlocked) throw new Error("the wallet is locked")
						return s.l1.chainId()
					},
					requestAccounts: async () => {
						unlocked = true
						return s.l1.accounts()
					},
				},
			}),
		})
		await clickSignIn(app.user)
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

	test("a sign-in replaced by Forget this device before its signature is asked for never reaches the wallet", async () => {
		let resume = () => {}
		const held = new Promise<void>((r) => (resume = r))
		const signTypedData = vi.fn(async () => FAKE_SIGNATURE)
		const app = renderApp({
			patch: (s) => ({
				...s,
				l1: { ...s.l1, signTypedData },
				sessions: { ...s.sessions, open: (a) => held.then(() => s.sessions.open(a)) },
			}),
		})
		await clickSignIn(app.user)
		await screen.findByText("Approve the signature in your Ethereum wallet")
		await app.user.click(button("Details"))
		await app.user.click(button("Forget this device"))
		await app.user.click(button("Forget"))
		await act(async () => resume())
		await act(() => new Promise((r) => setTimeout(r, 20)))
		expect(signTypedData).not.toHaveBeenCalled()
	})

	test("a sign-in the wallet answers after Forget this device stays signed out", async () => {
		let answer: (signature: Hex) => void = () => {}
		const signTypedData = () => new Promise<Hex>((resolve) => (answer = resolve))
		const app = renderApp({ patch: (s) => ({ ...s, l1: { ...s.l1, signTypedData } }) })
		await clickSignIn(app.user)
		await screen.findByText("Approve the signature in your Ethereum wallet")
		await app.user.click(button("Details"))
		await app.user.click(button("Forget this device"))
		await app.user.click(button("Forget"))
		await app.user.keyboard("{Escape}")
		await screen.findByRole("button", { name: "Sign in with Ethereum" })
		await act(async () => answer(FAKE_SIGNATURE))
		expect(screen.queryByText("Notes by label")).toBeNull()
		screen.getByRole("button", { name: "Sign in with Ethereum" })
	})
})
