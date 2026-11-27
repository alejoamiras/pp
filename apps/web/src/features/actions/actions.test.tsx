// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import type { AztecAddress } from "../../data/stack-types"
import { messageOf, PAYEE_MESSAGES, ProviderError, revertCopy } from "../../data/errors"
import { ACCOUNTS, LABELS } from "../../data/fixtures/seed"
import type { AztecReceipt } from "../../data/ports"
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
		expect(dialog.getByTestId("exit-collect-payer").textContent).toMatch(/funded Ethereum account.*Not your pool owner's/)

		// Elsewhere, 15 leaves the label: its notes become 15 and 10, and 40 is no longer a sum of whole notes.
		await act(() =>
			app.source.aztec.transferPrivate(
				ACCOUNTS.aztec,
				{ to: OTHER, amount: 15_000_000n, label: LABELS.active, origin: 0 },
				{ epoch: 0, handoff: () => {} },
			),
		)
		const sent = app.control.state().sent.aztec
		await app.user.click(dialog.getByRole("button", { name: /Leave to Ethereum/ }))
		await dialog.findByText(messageOf("NO_EXACT_CHUNKS"))
		expect(app.control.state().sent.aztec).toBe(sent)
		expect(app.control.state().exits).toEqual([])
	})

	test("a ragequit holds its lock from the click: a second click waits, and Back during the note read sends nothing", async () => {
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
		await signIn(app.user)
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, /Leave to Ethereum/)
		await app.user.click(await dialog.findByLabelText(/40\.00 USDC/))
		const payee = dialog.getByLabelText("Payee on Ethereum")
		await app.user.clear(payee)
		await app.user.type(payee, ACCOUNTS.sender)
		await app.user.click(await dialog.findByRole("button", { name: "Review" }))
		const leave = () => within(dialog.getByTestId("exit-review")).getByRole("button", { name: /Leave to Ethereum/ })
		hold = true
		await app.user.click(leave())
		expect(disabled(leave())).toBe(true)
		await app.user.click(dialog.getByRole("button", { name: "Back" }))
		await act(async () => {
			for (const release of held.splice(0)) release()
		})
		expect(app.control.state().exits).toEqual([])
		expect(dialog.queryByRole("alert")).toBeNull()
	})

	test("a private send refuses the zero address and an address off the curve, neither of which can receive notes", async () => {
		const app = renderApp()
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, "Send privately")
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		const to = dialog.getByLabelText("Recipient on Aztec")
		for (const bad of [0n, 3n]) {
			await app.user.clear(to)
			await app.user.type(to, `0x${bad.toString(16).padStart(64, "0")}`)
			dialog.getByText(messageOf("RECIPIENT_INVALID"))
			expect(disabled(dialog.getByRole("button", { name: "Send" }))).toBe(true)
		}
		await app.user.clear(to)
		await app.user.type(to, OTHER)
		expect(disabled(dialog.getByRole("button", { name: "Send" }))).toBe(false)
		expect(app.control.state().sent.aztec).toBe(0)
	})

	test("a send whose outcome could not be read is not confirmed, not failed, and keeps its hash on screen", async () => {
		const hash = `0x${"5e".repeat(32)}` as const
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: { ...s.aztec, transferPrivate: async () => ({ txHash: hash, status: "unconfirmed" as const }) },
			}),
		})
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, "Send privately")
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		await app.user.type(dialog.getByLabelText("Recipient on Aztec"), OTHER)
		await app.user.click(dialog.getByRole("button", { name: "Send" }))
		const alert = within(await dialog.findByRole("alert"))
		alert.getByText("Not confirmed")
		alert.getByText(messageOf("TX_UNCONFIRMED"))
		alert.getByText(/Transaction 0x5e5e/)
	})

	test("a send that may still land holds its account until a Refresh reads it included, through a pending answer and a failed read", async () => {
		const hash = `0x${"5e".repeat(32)}` as const
		let receipt: AztecReceipt | null = { status: "pending" }
		let reads = 0
		const app = renderApp({
			patch: (s) => ({
				...s,
				receipts: {
					aztec: async () => {
						reads++
						if (receipt === null) throw new Error("the node is unreachable")
						return receipt
					},
				},
				aztec: {
					...s.aztec,
					transferPrivate: async (_from, _a, on) => {
						on.handoff()
						return { txHash: hash, status: "unconfirmed" as const }
					},
				},
			}),
		})
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, "Send privately")
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		await app.user.type(dialog.getByLabelText("Recipient on Aztec"), OTHER)
		await app.user.click(dialog.getByRole("button", { name: "Send" }))
		await dialog.findByText(messageOf("TX_UNCONFIRMED"))
		await app.user.click(dialog.getByRole("button", { name: "Cancel" }))
		const row = () => labelRow(LABELS.active)
		const held = () =>
			["Send privately", "Unshield", /Leave to Ethereum/].every((name) => disabled(row().getByRole("button", { name })))
		await waitFor(() => row().getAllByText(messageOf("TX_UNSETTLED")))
		expect(held()).toBe(true)
		expect(reads, "only a Refresh reads the receipt").toBe(0)
		const readAgain = async () => {
			const before = reads
			await app.user.click(screen.getByRole("button", { name: "Refresh" }))
			await waitFor(() => expect(reads).toBeGreaterThan(before))
			await act(async () => {})
		}
		await readAgain()
		expect(held()).toBe(true)
		receipt = null
		await readAgain()
		expect(held()).toBe(true)
		receipt = { status: "success" }
		await readAgain()
		await waitFor(() => expect(disabled(row().getByRole("button", { name: "Send privately" }))).toBe(false))
	})

	test("a wallet send that throws past the handoff holds its account until reload, and the wallet's own no holds nothing", async () => {
		let refuse = true
		let reads = 0
		const app = renderApp({
			patch: (s) => ({
				...s,
				receipts: {
					aztec: async () => {
						reads++
						return { status: "success" }
					},
				},
				aztec: {
					...s.aztec,
					unshield: async (_from, _a, on) => {
						on.handoff()
						throw refuse ? new ProviderError(4001, "User rejected the request.") : new Error("the wallet's socket closed")
					},
				},
			}),
		})
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const unshield = async () => {
			const dialog = await openDialog(app, LABELS.active, "Unshield")
			await app.user.type(dialog.getByLabelText(/Amount/), "5")
			await app.user.click(dialog.getByRole("button", { name: "Unshield" }))
			return dialog
		}
		const declined = await unshield()
		await declined.findByText(messageOf("WALLET_REJECTED"))
		await app.user.click(declined.getByRole("button", { name: "Cancel" }))
		await waitFor(() => expect(disabled(labelRow(LABELS.active).getByRole("button", { name: "Unshield" }))).toBe(false))
		refuse = false
		const lost = await unshield()
		within(await lost.findByRole("alert")).getByText("Not confirmed")
		lost.getByText(messageOf("UNKNOWN"))
		await app.user.click(lost.getByRole("button", { name: "Cancel" }))
		await waitFor(() => labelRow(LABELS.active).getAllByText(messageOf("TX_UNSETTLED_NO_HASH")))
		await app.user.click(screen.getByRole("button", { name: "Refresh" }))
		await act(async () => {})
		expect(disabled(labelRow(LABELS.active).getByRole("button", { name: "Send privately" }))).toBe(true)
		expect(reads).toBe(0)
	})

	test.each([
		["Send privately", "Send"],
		["Unshield", "Unshield"],
	])("%s takes at most the label's 8 largest notes", async (row, submit) => {
		const nine = [5, 5, 5, 5, 5, 5, 5, 4, 1].map((n) => BigInt(n) * 10n ** BigInt(6))
		const sent: string[] = []
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: {
					...s.aztec,
					notesByLabel: async (owner, label) => (label === LABELS.active ? nine : s.aztec.notesByLabel(owner, label)),
					transferPrivate: (from, a, on) => {
						sent.push("send")
						return s.aztec.transferPrivate(from, a, on)
					},
					unshield: (from, a, on) => {
						sent.push("unshield")
						return s.aztec.unshield(from, a, on)
					},
				},
			}),
		})
		await signIn(app.user)
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, row)
		await dialog.findByText(/^One transaction spends at most this label's 8 largest notes: up to 39 USDC\. Move the rest/)
		if (row === "Send privately") await app.user.type(dialog.getByLabelText("Recipient on Aztec"), OTHER)
		const amount = dialog.getByLabelText(/Amount/)
		await app.user.type(amount, "40")
		expect(disabled(dialog.getByRole("button", { name: submit }))).toBe(true)
		await app.user.clear(amount)
		await app.user.type(amount, "39")
		await app.user.click(dialog.getByRole("button", { name: submit }))
		await waitFor(() => expect(sent).toHaveLength(1))
	})

	test("a ragequit whose outcome was not read still lists its payee's exits", async () => {
		const asked: string[] = []
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: {
					...s.aztec,
					ragequit: async (_from, _a, on) => {
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
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, /Leave to Ethereum/)
		await app.user.click(await dialog.findByLabelText(/40\.00 USDC/))
		const payee = dialog.getByLabelText("Payee on Ethereum")
		await app.user.clear(payee)
		await app.user.type(payee, ACCOUNTS.sender)
		await app.user.click(await dialog.findByRole("button", { name: "Review" }))
		await app.user.click(within(dialog.getByTestId("exit-review")).getByRole("button", { name: /Leave to Ethereum/ }))
		await dialog.findByText(messageOf("UNKNOWN"))
		await app.user.click(dialog.getByRole("button", { name: "Cancel" }))
		await app.user.click(screen.getByRole("button", { name: "Exits" }))
		await waitFor(() => expect(asked).toContain(ACCOUNTS.sender))
	})

	test("a revert reason the page does not list never renders, and a listed one shows only its own sentence", async () => {
		/** The failed dialog's text after an unshield the chain reverts with `reason`. */
		async function revertedWith(reason: string): Promise<string> {
			const app = renderApp({
				patch: (s) => ({
					...s,
					aztec: { ...s.aztec, unshield: async () => ({ txHash: "0x01", status: "reverted", block: 9, reason }) },
				}),
			})
			await connectAztec(app.user)
			await screen.findAllByTestId("label-row")
			const dialog = await openDialog(app, LABELS.active, "Unshield")
			await app.user.type(dialog.getByLabelText(/Amount/), "5")
			await app.user.click(dialog.getByRole("button", { name: "Unshield" }))
			await dialog.findByText(messageOf("UNSHIELD_REVERTED"))
			const text = screen.getByTestId("action-dialog").textContent ?? ""
			cleanup()
			return text
		}
		const listed = await revertedWith("Assertion failed: roots changed")
		expect(listed).toContain(revertCopy("roots changed"))
		expect(listed).not.toContain("Assertion failed")
		const unlisted = await revertedWith("<b>Assertion failed</b>: visit evil.example to recover your funds")
		expect(unlisted).not.toContain("evil.example")
		expect(unlisted).not.toContain("Assertion failed")
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

	test("the finality hold lasts until the node's proven block reaches the revert's block, and through a failed read of it", async () => {
		const REVERT_BLOCK = 40
		let proven: number | null = REVERT_BLOCK - 1
		let reads = 0
		const app = renderApp({
			patch: (s) => ({
				...s,
				clock: {
					...s.clock,
					aztecProven: async () => {
						reads++
						if (proven === null) throw new Error("the node is unreachable")
						return proven
					},
				},
				aztec: { ...s.aztec, unshield: async () => ({ txHash: "0x01", status: "reverted", block: REVERT_BLOCK }) },
			}),
		})
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		const dialog = await openDialog(app, LABELS.active, "Unshield")
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		await app.user.click(dialog.getByRole("button", { name: "Unshield" }))
		await dialog.findByText(messageOf("UNSHIELD_REVERTED"))
		await app.user.click(dialog.getByRole("button", { name: "Cancel" }))
		const held = () => disabled(labelRow(LABELS.active).getByRole("button", { name: "Send privately" }))
		/** Reads the proven block again, and waits until that read has settled on screen. */
		const readAgain = async () => {
			const before = reads
			await app.user.click(screen.getByRole("button", { name: "Refresh" }))
			await waitFor(() => expect(reads).toBeGreaterThan(before))
			await act(async () => {})
		}
		await waitFor(() => labelRow(LABELS.active).getByText(messageOf("WAIT_FINALITY")))

		// Three Aztec slots of chain time pass while the node cannot say what is proven: the hold stays.
		proven = null
		act(() => app.control.advance(18))
		await readAgain()
		expect(held()).toBe(true)
		proven = REVERT_BLOCK - 1
		await readAgain()
		expect(held()).toBe(true)
		proven = REVERT_BLOCK
		await readAgain()
		await waitFor(() => expect(held()).toBe(false))
	})
})

describe("the shield dialog", () => {
	const openShield = async (app: ReturnType<typeof renderApp>) => {
		const shield = () => within(screen.getByTestId("public-row")).getByRole("button", { name: "Shield" })
		await waitFor(() => expect(disabled(shield())).toBe(false))
		await app.user.click(shield())
		return within(await screen.findByTestId("action-dialog"))
	}

	test("a dialog opened under one connection does not come back under the next, even for the same account", async () => {
		const app = renderApp()
		await connectAztec(app.user)
		await openShield(app)
		act(() => app.control.disconnectAztec())
		await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull())
		await connectAztec(app.user)
		await screen.findAllByTestId("label-row")
		expect(screen.queryByTestId("action-dialog")).toBeNull()
		expect(app.control.state().sent.aztec).toBe(0)
	})

	test("a shield whose connection ends while it waits to send sends nothing", async () => {
		let release = () => {}
		let entered = false
		const held = new Promise<void>((r) => {
			release = r
		})
		const app = renderApp({
			patch: (s) => ({
				...s,
				aztec: {
					...s.aztec,
					shield: async (from, amount, on) => {
						entered = true
						await held
						return s.aztec.shield(from, amount, on)
					},
				},
			}),
		})
		await connectAztec(app.user)
		const dialog = await openShield(app)
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		await app.user.click(dialog.getByRole("button", { name: "Shield" }))
		await waitFor(() => expect(entered).toBe(true))
		act(() => app.control.disconnectAztec())
		await act(async () => release())
		expect(app.control.state().sent.aztec).toBe(0)
	})

	test("a new label reads Not enabled yet, then Funds enabled at the next refetch after approval, with no Refresh", async () => {
		// Only intervals are faked, and they still advance with real time, so the wallet, the dialog and waitFor run as usual.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true })
		onTestFinished(() => void vi.useRealTimers())
		let reads = 0
		const app = renderApp({
			poll: 6_000,
			patch: (s) => ({
				...s,
				allowList: {
					...s.allowList,
					current: () => {
						reads++
						return s.allowList.current()
					},
				},
			}),
		})
		await connectAztec(app.user)
		const before = new Set((await screen.findAllByTestId("label-row")).map((r) => r.dataset.label))
		const dialog = await openShield(app)
		await app.user.type(dialog.getByLabelText(/Amount/), "5")
		await app.user.click(dialog.getByRole("button", { name: "Shield" }))
		await dialog.findByText(/^Shielded\./)
		await app.user.click(dialog.getByRole("button", { name: "Close" }))
		const label = await waitFor(() => {
			const born = screen.getAllByTestId("label-row").find((r) => !before.has(r.dataset.label))
			expect(born).toBeDefined()
			return BigInt(born?.dataset.label ?? "")
		})
		await waitFor(() => labelRow(label).getByText("Not enabled yet"))
		expect(disabled(labelRow(label).getByRole("button", { name: "Send privately" }))).toBe(true)

		const seen = reads
		act(() => app.control.approveBirths())
		await act(() => vi.advanceTimersByTimeAsync(6_000))
		await waitFor(() => labelRow(label).getByText("Funds enabled"))
		expect(reads).toBeGreaterThan(seen)
		await app.user.click(labelRow(label).getByRole("button", { name: "Send privately" }))
		within(await screen.findByTestId("action-dialog")).getByRole("heading", { name: "Send privately" })
	})
})
