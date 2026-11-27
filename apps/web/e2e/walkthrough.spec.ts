/**
 * The fixture world on the production bundle: every screen renders, a bridge runs to claimed on chain
 * time the test drives, and the page picks the bridge up again after a reload. It fails on what only
 * the built bundle can break: bundling, the node polyfills, the CSP and the `sessionStorage` resume.
 *
 * Payer: none; the claim is the fixture world's, and the wallet frame hands the node nothing. This
 * build's chain IS the fixture world, so the postconditions come from `__ppFixtures.state()`, not from
 * the sandbox; the sandbox serves only the wallet.
 */
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { advance, connectWallet, fixtureState, recordFirst, selectL1Account, signInToPool, submitted, watchPage } from "./support"

test.use({ family: "walkthrough", cells: 1, spares: 0 })

/** The seeded approved note (100 of the 6-decimal token), as its row carries its commitment. */
const NOTE = "4097"
const AMOUNT = "70000000"
const CHANGE = "30000000"
/** One Aztec slot of Ethereum blocks: a bridge mined in the first slot is claimable in the next. */
const SLOT = 6

test("renders every screen, bridges a note to claimed, and resumes the bridge after a reload", async ({ page, run, actor }) => {
	const watch = await watchPage(page)
	const recipient = actor.address.toLowerCase()
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const bridgeScreen = page.getByTestId("bridge-screen")
	const sections = page.getByRole("navigation", { name: "Sections" })

	await page.goto("/")
	const label = (await fixtureState(page)).notes.find((n) => n.commitment === NOTE)?.label
	if (label === undefined) throw new Error(`the seeded world has no note ${NOTE}`)

	await test.step("home, exits and details", async () => {
		await expect(page.getByTestId("eth-sign-in-panel")).toBeVisible()
		await signInToPool(page)
		await expect(page.locator('[data-testid="note-row"]')).toHaveCount(2)
		await connectWallet(page, wallet)
		await expect(page.getByTestId("allow-list-age")).toBeVisible()
		await expect(page.getByTestId("connect-panel")).toContainText("No private balance on this account yet")

		await sections.getByRole("button", { name: "Exits" }).click()
		await expect(page.getByTestId("exits-screen")).toContainText("No exits yet")
		await sections.getByRole("button", { name: "Balances" }).click()

		await page.getByRole("button", { name: "Details", exact: true }).click()
		const details = page.getByRole("dialog", { name: "Details" })
		await expect(details.getByTestId("recovery-precise")).toBeVisible()
		await details.getByRole("button", { name: "Close" }).click()
		await expect(details).toBeHidden()
	})

	await test.step("the bridge form, the proving pause, then mined", async () => {
		await selectL1Account(page, "sender")
		await page.locator(`[data-testid="note-row"][data-commitment="${NOTE}"]`).getByRole("button", { name: "Bridge to Aztec" }).click()
		const form = page.getByTestId("bridge-form")
		await form.getByLabel(/Amount to bridge/).fill("70")
		const submit = form.getByRole("button", { name: "Bridge to Aztec" })
		await expect(submit).toBeEnabled()
		// The fixture prove settles two frames after the pause paints: too brief to poll for.
		const proving = await recordFirst(page, "proving")
		await submit.click()
		await expect(bridgeScreen).toHaveAttribute("data-step", "mined")
		expect(await proving.seen(), "the proving pause painted first").toContain("the page may pause for a few seconds")
		const s = await fixtureState(page)
		expect(s.bridges).toEqual([
			{ id: expect.any(String), amount: AMOUNT, label, state: "mined", l1TxHash: expect.stringMatching(/^0x/) },
		])
		expect(s.sent).toEqual({ l1: 1, aztec: 0 })
		await watch.clean()
	})

	const frame = await test.step("a reload resumes the mined bridge from sessionStorage, and it is claimed", async () => {
		await page.reload()
		expect((await fixtureState(page)).bridges).toMatchObject([{ state: "mined", l1TxHash: expect.stringMatching(/^0x/) }])
		await selectL1Account(page, "owner")
		await signInToPool(page)
		const reconnected = await connectWallet(page, wallet)
		const record = page.getByTestId("bridge-record")
		await expect(record).toContainText("Mined; waiting for Aztec")
		await record.getByRole("button", { name: "Open" }).click()
		await expect(bridgeScreen).toHaveAttribute("data-step", "mined")

		await advance(page, SLOT)
		await expect(bridgeScreen).toHaveAttribute("data-step", "claimable")
		await bridgeScreen.getByRole("button", { name: "Claim on Aztec" }).click()
		await expect(bridgeScreen).toHaveAttribute("data-step", "claimed")

		const s = await fixtureState(page)
		expect(s.bridges).toMatchObject([{ amount: AMOUNT, label, state: "claimed" }])
		expect(s.balances).toContainEqual({ owner: recipient, label, origin: 0, value: AMOUNT })
		expect(s.notes).toContainEqual(expect.objectContaining({ commitment: NOTE, status: "spent" }))
		expect(s.notes).toContainEqual(expect.objectContaining({ label, value: CHANGE, status: "approved" }))
		expect(s.sent).toEqual({ l1: 1, aztec: 1 })
		return reconnected
	})

	await test.step("the claimed label's actions open, and an action dialog renders", async () => {
		await bridgeScreen.getByRole("button", { name: "Back to balances" }).last().click()
		const row = page.locator(`[data-testid="label-row"][data-label="${label}"]`)
		await expect(row).toHaveAttribute("data-state", "ACTIVE")
		for (const name of ["Send privately", "Unshield", "Leave to Ethereum (ragequit)"])
			await expect(row.getByRole("button", { name })).toBeEnabled()
		await row.getByRole("button", { name: "Send privately", exact: true }).click()
		const dialog = page.locator('[data-testid="action-dialog"][data-action="send"]')
		await expect(dialog).toBeVisible()
		await dialog.getByRole("button", { name: "Cancel" }).click()
		await expect(dialog).toBeHidden()
	})

	expect(await submitted(frame)).toEqual([])
	await watch.clean()
})
