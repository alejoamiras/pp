/**
 * The wallet's own screens, driven the way a person would, against the test ids of the pinned
 * release (tag v1.3.0). The password is made per run by the caller and never written anywhere.
 */
import { type BrowserContext, expect, type Page } from "@playwright/test"

export interface WalletDriver {
	/** The first-run tab: Terms, create with a password, defer the phrase; ends on the popup's Home. */
	onboard(): Promise<void>
	/** Adds a custom network in Settings with Developer Mode on; returns the wallet chain id its detail shows. */
	addNetwork(name: string, nodeUrl: string): Promise<number>
	/** The popup document, opened in a tab (a toolbar popup is unreachable in headless Chromium). */
	popup(): Page
}

const STEP_MS = 60_000

const input = (page: Page, testId: string) => page.getByTestId(testId).locator("input")

async function goHash(page: Page, hash: string): Promise<void> {
	await page.evaluate((h) => {
		window.location.hash = h
	}, hash)
	await page.waitForFunction((h) => window.location.hash.startsWith(h), hash, { timeout: STEP_MS })
}

async function firstRunTab(context: BrowserContext, origin: string): Promise<Page> {
	const isOnboarding = (p: Page) => p.url().startsWith(`${origin}/src/onboarding/`)
	const open = context.pages().find(isOnboarding)
	if (open) return open
	return context.waitForEvent("page", { predicate: isOnboarding, timeout: STEP_MS })
}

export function walletDriver(context: BrowserContext, extensionId: string, password: string): WalletDriver {
	const origin = `chrome-extension://${extensionId}`
	let popupPage: Page | undefined

	return {
		async onboard() {
			const tab = await firstRunTab(context, origin)
			await tab.getByTestId("onboarding-welcome-create").click({ timeout: STEP_MS })
			await tab.getByTestId("legal-consent-checkbox").check()
			await tab.getByTestId("legal-continue").click()
			await tab.getByTestId("onboarding-method-password").click({ timeout: STEP_MS })
			await input(tab, "onboarding-password-input").fill(password)
			await input(tab, "onboarding-password-confirm").fill(password)
			await tab.getByTestId("onboarding-submit-create").click()
			await tab.getByTestId("onboarding-phrase-later").click({ timeout: STEP_MS })
			await tab.getByTestId("onboarding-done-open").click({ timeout: STEP_MS })
			popupPage = await context.newPage()
			await popupPage.goto(`${origin}/src/popup/index.html#/popup/general`)
			await popupPage.waitForFunction(() => window.location.hash.startsWith("#/popup/general"), undefined, { timeout: STEP_MS })
			// Home mounting ends the popup's bootstrap; a hash set before it is overwritten by its redirect.
			await popupPage.getByTestId("balance-amount").waitFor({ timeout: STEP_MS })
		},

		async addNetwork(name, nodeUrl) {
			const page = this.popup()
			await goHash(page, "#/popup/settings/developer")
			const toggle = page.getByTestId("settings-toggle-developerMode")
			if ((await toggle.getAttribute("aria-checked", { timeout: STEP_MS })) !== "true") await toggle.click()
			await expect(toggle).toHaveAttribute("aria-checked", "true")
			await goHash(page, "#/popup/settings/networks")
			await page.getByTestId("network-new-btn").click({ timeout: STEP_MS })
			await input(page, "network-name-input").fill(name)
			await input(page, "network-rpc-input").fill(nodeUrl)
			await page.getByTestId("new-network-submit").click()
			await expect(page.getByText("Network is created")).toBeVisible({ timeout: STEP_MS })
			await goHash(page, "#/popup/settings/networks")
			await page.locator(`[data-testid="network-row"][data-network-name="${name}"]`).click({ timeout: STEP_MS })
			const shown = (await page.getByTestId("network-detail-chain-id").textContent({ timeout: STEP_MS })) ?? ""
			const id = Number.parseInt(shown.replace(/[^\d]/g, ""), 10)
			if (!Number.isSafeInteger(id)) throw new Error(`driver: the network detail shows no chain id (${JSON.stringify(shown)})`)
			return id
		},

		popup() {
			if (!popupPage) throw new Error("driver: onboard() opens the popup first")
			return popupPage
		},
	}
}
