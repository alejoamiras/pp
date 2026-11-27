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
})
