/**
 * Connect, on the production bundle against the sandbox. Each test proves a part of the wallet SDK,
 * its iframe, cross-origin isolation and the CSP working together, which jsdom cannot show. Payer:
 * none; a connect sends nothing, and each test reads from the wallet frame that it handed the node no
 * transaction. Dispatch per granted scope is the unit suite's; here, what the page shows for a grant.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { messageOf } from "../src/data/errors"
import { chooseWallet, connectWallet, declineNextGrant, signInToPool, submitted, walletOption, watchPage } from "./support"

test.use({ family: "connect", cells: 3, spares: 0 })

/** The seeded approved pool note's commitment, as its row carries it. */
const BRIDGEABLE_NOTE = "4097"

// Fails if the page or the wallet frame is not cross-origin isolated, the served headers drift from
// the built ones, or the SDK, Radix or zod trip the CSP.
test("connects the plain wallet in an isolated page and frame, under the CSP, sending nothing", async ({ page, run, actor }) => {
	const watch = await watchPage(page)

	const response = await page.goto("/")
	const served = response?.headers() ?? {}
	const built = JSON.parse(readFileSync(join(run.appDist, "security-headers.json"), "utf8")) as Record<string, string>
	expect(served["cross-origin-opener-policy"]).toBe("same-origin")
	expect(served["cross-origin-embedder-policy"]).toBe("require-corp")
	expect(served["content-security-policy"]).toBe(built["Content-Security-Policy"])
	expect(served["content-security-policy"]).toContain(`frame-src ${run.testWalletOrigins.plain} ${run.testWalletOrigins.full}`)
	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)

	const frame = await connectWallet(page, { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address })
	expect(await frame.evaluate(() => crossOriginIsolated)).toBe(true)
	expect(await submitted(frame)).toEqual([])
	await watch.clean()
})

// Fails if discovery misses a frame-src origin (each profile is its own), a probe answer is dropped, or
// the secure channel to the second origin does not reach its emoji check.
test("discovers both wallet profiles and connects the full one after its emoji check", async ({ page, run, actor }) => {
	const watch = await watchPage(page)
	await page.goto("/")
	await page.getByTestId("connect-button").click()
	for (const profile of ["plain", "full"] as const) {
		await expect(walletOption(page, profile)).toContainText(`Test wallet (${profile})`)
		await expect(walletOption(page, profile)).toContainText("Web wallet")
	}

	const frame = await chooseWallet(page, { profile: "full", origin: run.testWalletOrigins.full, account: actor.address })
	await expect(page.getByTestId("aztec-wallet-name")).toHaveText("Test wallet (full)")
	expect(await frame.evaluate(() => crossOriginIsolated)).toBe(true)
	expect(await submitted(frame)).toEqual([])
	await watch.clean()
})

// Fails if the page reads a grant it was not given: a declined contract scope must close the bridge and
// every token action, with a reason, and a later full grant must lift exactly that refusal.
test("a declined grant closes the bridge and token actions with a reason; granting again opens them", async ({ page, run, actor }) => {
	const watch = await watchPage(page)
	await page.goto("/")
	await signInToPool(page)
	const bridge = page
		.locator(`[data-testid="note-row"][data-commitment="${BRIDGEABLE_NOTE}"]`)
		.getByRole("button", { name: "Bridge to Aztec" })
	const publicRow = page.getByTestId("public-row")
	const tokenActions = ["Shield", "Withdraw to Ethereum"].map((name) => publicRow.getByRole("button", { name, exact: true }))
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const

	const declined = await connectWallet(page, { ...wallet, whileVerifying: declineNextGrant })
	await expect(page.getByTestId("connect-panel")).toContainText("Your balances are hidden from this page")
	await expect(bridge).toBeDisabled()
	await expect(bridge).toHaveAccessibleDescription("Your Aztec wallet did not allow claiming. Connect again and allow it.")
	for (const action of tokenActions) {
		await expect(action).toBeDisabled()
		await expect(action).toHaveAccessibleDescription(messageOf("NOT_GRANTED"))
	}
	expect(await submitted(declined)).toEqual([])

	await page.getByTestId("disconnect-button").click()
	const granted = await connectWallet(page, wallet)
	await expect(page.getByTestId("connect-panel")).toContainText("No private balance on this account yet")
	await expect(bridge).toBeEnabled()
	// The grant no longer closes them; the account's empty public balance is the reason now.
	for (const action of tokenActions) await expect(action).toHaveAccessibleDescription("Your public balance is empty.")
	expect(await submitted(granted)).toEqual([])
	await watch.clean()
})
