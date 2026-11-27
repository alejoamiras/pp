// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ExitStatus, ExitTicket } from "../../data/stack-types"
import { BridgeFailure, messageOf, ProviderError } from "../../data/errors"
import { ACCOUNTS, LABELS } from "../../data/fixtures/seed"
import type { ExitView } from "../../data/ports"
import { renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

type User = ReturnType<typeof renderApp>["user"]

const review = () => within(screen.getByTestId("collect-review"))

/** Opens the collect's review and confirms it. */
async function confirmCollect(user: User, button?: HTMLElement): Promise<void> {
	await user.click(button ?? (await screen.findByRole("button", { name: "Collect on Ethereum" })))
	await screen.findByTestId("collect-review")
	await user.click(review().getByRole("button", { name: "Collect" }))
}

const L2_TX = `0x${"ab".repeat(32)}` as const
const L1_TX = `0x${"cd".repeat(32)}` as const

/** One ready public exit to the owner. */
const oneReady = (d: { id: string; token: ExitTicket["token"] }): ExitView[] => [
	{
		key: { deployment: d.id, l2TxHash: L2_TX, messageIndexInTx: 0 },
		ticket: { kind: "public", token: d.token, payee: ACCOUNTS.owner, amount: 1n, l2TxHash: L2_TX, messageIndexInTx: 0 },
		status: "ready",
	},
]

describe("exits", () => {
	test("two identical exits, one settled, are two rows; a ready one collects after a declined try; a proving one offers nothing", async () => {
		let settled = false
		let declines = 1
		const views = (deployment: string, token: ExitTicket["token"]): ExitView[] => {
			const ticket = (i: number): ExitTicket => ({
				kind: "ragequit",
				token,
				payee: ACCOUNTS.owner,
				amount: 25_000_000n,
				label: LABELS.active,
				l2TxHash: L2_TX,
				messageIndexInTx: i,
			})
			const status: ExitStatus[] = ["settled", settled ? "settled" : "ready", "proving"]
			return status.map((s, i) => ({ key: { deployment, l2TxHash: L2_TX, messageIndexInTx: i }, ticket: ticket(i), status: s }))
		}
		const settle = vi.fn(async () => {
			if (declines-- > 0) throw new ProviderError(4001, "User rejected the request.")
			settled = true
			return L2_TX
		})
		const app = renderApp({
			patch: (s) => ({ ...s, exits: { tickets: async () => views(s.deployment.id, s.deployment.token), settle } }),
		})
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		const statuses = () => screen.getAllByTestId("exit-row").map((r) => r.dataset.status)
		await waitFor(() => expect(statuses()).toEqual(["settled", "ready", "proving"]))
		const [, ready, proving] = screen.getAllByTestId("exit-row") as HTMLElement[]
		expect(within(proving as HTMLElement).queryByRole("button", { name: "Collect on Ethereum" })).toBeNull()

		await confirmCollect(app.user, within(ready as HTMLElement).getByRole("button", { name: "Collect on Ethereum" }))
		await screen.findByText(messageOf("WALLET_REJECTED"))
		await confirmCollect(
			app.user,
			within(screen.getAllByTestId("exit-row")[1] as HTMLElement).getByRole("button", { name: "Collect on Ethereum" }),
		)
		await waitFor(() => expect(statuses()).toEqual(["settled", "settled", "proving"]))
		expect(settle).toHaveBeenCalledTimes(2)
	})

	test.each([
		["UNCERTAIN", undefined, "Not confirmed", /could not confirm whether your collect went out\. Refresh before collecting again/],
		["UNCERTAIN", L1_TX, "Not confirmed", /from another account it also shows that account next to the payee/],
		["RPC_INCONSISTENT", L1_TX, "Not confirmed", /inconsistent answers/],
		["RPC_FAILED", undefined, "Not collected", /^A network request failed\. Try again\.$/],
		["REVERTED", L1_TX, "Not collected", /reverted on Ethereum and paid nothing/],
	] as const)(
		"a collect that ends %s with hash %s is titled %s, keeps its hash and is worded for the exit",
		async (code, l1TxHash, title, sentence) => {
			const app = renderApp({
				patch: (s) => ({
					...s,
					exits: {
						tickets: async () => oneReady(s.deployment),
						settle: async () => {
							throw new BridgeFailure(code, l1TxHash ? { l1TxHash } : {})
						},
					},
				}),
			})
			await app.user.click(screen.getByRole("button", { name: "Exits" }))
			await confirmCollect(app.user)
			const alert = within(await screen.findByRole("alert"))
			alert.getByText(title)
			alert.getByText(sentence)
			expect(alert.queryByTitle(L1_TX) !== null).toBe(l1TxHash !== undefined)
		},
	)

	test("a failure read before the exit settled leaves the row once a Refresh reads it collected", async () => {
		let settled = false
		const app = renderApp({
			patch: (s) => ({
				...s,
				exits: {
					tickets: async () => oneReady(s.deployment).map((v) => ({ ...v, status: settled ? "settled" : v.status })),
					settle: async () => {
						settled = true
						throw new BridgeFailure("UNCERTAIN")
					},
				},
			}),
		})
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await confirmCollect(app.user)
		await waitFor(() => expect(screen.getByTestId("exit-row").dataset.status).toBe("settled"))
		expect(screen.queryByRole("alert")).toBeNull()
	})

	test("the review names sender and payee, says a separate sender is linked to the payee, and refuses the owner without an explicit yes", async () => {
		const settle = vi.fn(async () => L1_TX)
		const app = renderApp({ patch: (s) => ({ ...s, exits: { tickets: async () => oneReady(s.deployment), settle } }) })
		await signIn(app.user)
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		const open = async () => {
			await app.user.click(await screen.findByRole("button", { name: "Collect on Ethereum" }))
			return within(await screen.findByTestId("collect-review"))
		}
		const collect = () => review().getByRole<HTMLButtonElement>("button", { name: "Collect" })
		;(await open()).getByText("This is your pool owner's address")
		expect(collect().disabled).toBe(true)
		await app.user.click(review().getByRole("button", { name: "Back" }))
		act(() => app.control.selectL1Account("sender"))
		;(await open()).getByText(new RegExp(`from ${ACCOUNTS.sender} that pays ${ACCOUNTS.owner}`))
		review().getByText("This links two addresses in public")
		expect(collect().disabled).toBe(false)
		await app.user.click(review().getByRole("button", { name: "Back" }))
		act(() => app.control.selectL1Account("owner"))
		await (await open()).findByText("This is your pool owner's address")
		await app.user.click(review().getByTestId("collect-owner-override"))
		await app.user.click(collect())
		await waitFor(() =>
			expect(settle).toHaveBeenCalledWith(expect.anything(), { sender: ACCOUNTS.owner, demo: false }, expect.anything()),
		)
	})

	test("a collect confirmed before the owner signed in with its sender sends nothing at the handoff", async () => {
		let release: () => void = () => {}
		const sent = vi.fn()
		const app = renderApp({
			patch: (s) => ({
				...s,
				exits: {
					tickets: async () => oneReady(s.deployment),
					settle: async (_t, _from, on) => {
						await new Promise<void>((r) => {
							release = r
						})
						try {
							on.handoff()
						} catch {
							throw new ProviderError(4001, "The wallet context changed; nothing was sent.")
						}
						sent()
						return L1_TX
					},
				},
			}),
		})
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await confirmCollect(app.user)
		await app.user.click(screen.getByRole("button", { name: "Balances" }))
		await signIn(app.user)
		release()
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await screen.findByText(/signed in with the sending account before the collect went out/)
		expect(sent).not.toHaveBeenCalled()
	})

	test("a collect still in flight when the Exits screen is left and reopened is not offered again", async () => {
		let release: (h: typeof L2_TX) => void = () => {}
		const settle = vi.fn(() => new Promise<typeof L2_TX>((r) => (release = r)))
		const app = renderApp({
			patch: (s) => ({
				...s,
				exits: {
					tickets: async () => oneReady(s.deployment),
					settle,
				},
			}),
		})
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await confirmCollect(app.user)
		await app.user.click(screen.getByRole("button", { name: "Balances" }))
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		const again = await screen.findByRole("button", { name: "Collect on Ethereum" })
		expect((again as HTMLButtonElement).disabled).toBe(true)
		await app.user.click(again)
		release(L2_TX)
		const collect = () => screen.getByRole("button", { name: "Collect on Ethereum" }) as HTMLButtonElement
		await waitFor(() => expect(collect().disabled).toBe(false))
		expect(settle).toHaveBeenCalledTimes(1)
	})

	test("a collect held while the wallet moves to another chain says the wallet changed and nothing was sent", async () => {
		const app = renderApp({
			patch: (s) => ({
				...s,
				exits: {
					tickets: async () => [
						{
							key: { deployment: s.deployment.id, l2TxHash: L2_TX, messageIndexInTx: 0 },
							ticket: {
								kind: "public",
								token: s.deployment.token,
								payee: ACCOUNTS.owner,
								amount: 1n,
								l2TxHash: L2_TX,
								messageIndexInTx: 0,
							},
							status: "ready",
						},
					],
					settle: async (_t, _sender, on) => {
						app.control.setL1Chain(1)
						// The stack's guard answers a refused handoff with a 4001, which reads like the wallet's own no.
						try {
							on.handoff()
						} catch {
							throw new ProviderError(4001, "The wallet context changed; nothing was sent.")
						}
						return L2_TX
					},
				},
			}),
		})
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		const collect = await screen.findByRole("button", { name: "Collect on Ethereum" })
		await waitFor(() => expect((collect as HTMLButtonElement).disabled).toBe(false))
		await confirmCollect(app.user, collect)
		await screen.findByText(messageOf("CONTEXT_CHANGED"))
	})
})
