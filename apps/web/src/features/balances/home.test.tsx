// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import type { PoolNoteView } from "../../data/stack-types"
import { LABELS } from "../../data/fixtures/seed"
import { connectAztec, labelRow, noteRow, renderApp, signIn } from "../../test-utils/app"

afterEach(cleanup)

const note = (commitment: bigint, value: bigint, status: PoolNoteView["status"]): PoolNoteView => ({
	commitment,
	label: commitment * 1_000_003n,
	value,
	asset: "0x00000000000000000000000000000000000a55e7",
	status,
})

const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled
const reasonOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent

describe("home", () => {
	test("no bridge for pending, revoked, exiting or zero-value notes; only an approved note with a value offers one", async () => {
		const notes = [
			note(1n, 100n, "approved"),
			note(2n, 25n, "pending"),
			note(3n, 9n, "revoked"),
			note(4n, 9n, "exiting"),
			note(5n, 0n, "approved"),
		]
		const app = renderApp({
			patch: (s) => ({
				...s,
				sessions: { ...s.sessions, open: async (a) => ({ ...(await s.sessions.open(a)), notes: async () => notes }) },
			}),
		})
		await signIn(app.user)
		await connectAztec(app.user)
		noteRow(1n).getByRole("button", { name: "Bridge to Aztec" })
		for (const [c, status, reason] of [
			[2n, "Not approved yet", "The pool has not approved this note"],
			[3n, "Approval withdrawn", "The pool withdrew this note's approval; it can return"],
			[4n, "Leaving the pool", "This note is leaving the pool; it can return after a reorg"],
		] as const) {
			const row = noteRow(c)
			row.getByText(status)
			row.getByText(reason)
			expect(row.queryByRole("button", { name: "Bridge to Aztec" })).toBeNull()
		}
		expect(screen.queryAllByTestId("note-row").map((r) => r.dataset.commitment)).not.toContain("5")
		screen.getByText("1 empty note (left by bridging a whole note) not shown.")
	})

	test("ABSENT and STALE_ROOT close Send and Unshield with their reason, ragequit stays open, and the list's age is chain time", async () => {
		const app = renderApp()
		await connectAztec(app.user)
		await screen.findByText("Allow list #128 posted 4 min ago (chain time)")
		const bridged = labelRow(LABELS.revoked)
		bridged.getByText("Not found in the latest list")
		expect(reasonOf(bridged.getByRole("button", { name: "Send privately" }))).toBe(
			"Send and Unshield wait until the label is found in the allow list",
		)
		expect(isDisabled(bridged.getByRole("button", { name: "Unshield" }))).toBe(true)
		expect(isDisabled(bridged.getByRole("button", { name: /Leave to Ethereum/ }))).toBe(false)
		bridged.getByRole("button", { name: "Check again" })
		const shielded = labelRow(LABELS.shielded)
		expect(reasonOf(shielded.getByRole("button", { name: "Send privately" }))).toBe("Send and Unshield open once the label is approved")
		expect(isDisabled(labelRow(LABELS.active).getByRole("button", { name: "Send privately" }))).toBe(false)

		// Half an hour of chain time later, a proof could outlive the list's hour: too old to spend against.
		act(() => app.control.advance(150))
		await app.user.click(screen.getByRole("button", { name: "Refresh" }))
		await waitFor(() => labelRow(LABELS.active).getByText("List out of date"))
		const active = labelRow(LABELS.active)
		expect(reasonOf(active.getByRole("button", { name: "Unshield" }))).toBe("Send and Unshield wait for the next allow-list post")
		expect(isDisabled(active.getByRole("button", { name: /Leave to Ethereum/ }))).toBe(false)
	})
})
