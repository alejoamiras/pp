// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ExitStatus, ExitTicket } from "../../data/stack-types"
import { messageOf, ProviderError } from "../../data/errors"
import { ACCOUNTS, LABELS } from "../../data/fixtures/seed"
import type { ExitView } from "../../data/ports"
import { renderApp } from "../../test-utils/app"

afterEach(cleanup)

const L2_TX = `0x${"ab".repeat(32)}` as const

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

		await app.user.click(within(ready as HTMLElement).getByRole("button", { name: "Collect on Ethereum" }))
		await screen.findByText(messageOf("WALLET_REJECTED"))
		await app.user.click(
			within(screen.getAllByTestId("exit-row")[1] as HTMLElement).getByRole("button", { name: "Collect on Ethereum" }),
		)
		await waitFor(() => expect(statuses()).toEqual(["settled", "settled", "proving"]))
		expect(settle).toHaveBeenCalledTimes(2)
	})

	test("a collect still in flight when the Exits screen is left and reopened is not offered again", async () => {
		let release: (h: typeof L2_TX) => void = () => {}
		const settle = vi.fn(() => new Promise<typeof L2_TX>((r) => (release = r)))
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
					settle,
				},
			}),
		})
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await app.user.click(await screen.findByRole("button", { name: "Collect on Ethereum" }))
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
		await app.user.click(collect)
		await screen.findByText(messageOf("CONTEXT_CHANGED"))
	})
})
