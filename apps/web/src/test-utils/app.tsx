/**
 * Renders the whole app over a fresh fixture world. A "reload" is a second render over the same store,
 * as the browser's `sessionStorage` carries the world across one. Frames resolve at once and nothing
 * polls unless `poll` sets the production refetch interval, so the only clock is the fixture's chain time.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect } from "vitest"
import { AppRoot } from "../app/AppRoot"
import { createFixtureSource, type KeyValue } from "../data/fixtures"
import type { DataSource } from "../data/source"

export function memoryStore(): KeyValue {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

export function renderApp(o: { store?: KeyValue; patch?: (s: DataSource) => DataSource; poll?: number } = {}) {
	const { source, control } = createFixtureSource(o.store ?? memoryStore())
	const user = userEvent.setup({ pointerEventsCheck: 0 })
	const used = o.patch ? o.patch(source) : source
	const view = render(<AppRoot source={used} frame={async () => {}} poll={o.poll ?? false} />)
	return { source: used, control, user, ...view }
}

type User = ReturnType<typeof userEvent.setup>

/** Clicks the sign-in button once the wallet's account is read and it enables. */
export async function clickSignIn(user: User, name: string | RegExp = /Sign in/): Promise<void> {
	// A disabled ActionButton is a different element (it carries its reason), so query again each time.
	const button = () => screen.getByRole<HTMLButtonElement>("button", { name })
	await waitFor(() => expect(button().disabled).toBe(false))
	await user.click(button())
}

/** Signs in as the pool owner, as the fixture wallet first selects it. */
export async function signIn(user: User): Promise<void> {
	await clickSignIn(user)
	await screen.findByText("Notes by label")
}

export async function connectAztec(user: User): Promise<void> {
	await user.click(screen.getByTestId("connect-button"))
	await user.click(await screen.findByTestId("wallet-option"))
	await user.click(await screen.findByTestId("emoji-confirm"))
	await screen.findByTestId("aztec-account")
}

function byData(testId: string, key: string, value: bigint): HTMLElement {
	const row = screen.getAllByTestId(testId).find((r) => r.dataset[key] === value.toString())
	if (!row) throw new Error(`no ${testId} with ${key} ${value}`)
	return row
}

/** One pool note's row, scoped for `within`. */
export const noteRow = (commitment: bigint) => within(byData("note-row", "commitment", commitment))

/** One Aztec label's row, scoped for `within`. */
export const labelRow = (label: bigint) => within(byData("label-row", "label", label))
