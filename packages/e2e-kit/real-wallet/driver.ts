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
	/**
	 * From the app's connect button: the app's one Extension option, the wallet's Allow, both emoji
	 * grids compared before either side confirms, then the capability grant. Returns the grid both showed.
	 */
	connect(app: Page): Promise<string[]>
	/**
	 * Runs `trigger` with the execute window's wait already armed, then confirms once the window
	 * allows it. Returns the window for the caller's record; it closes itself once the wallet answers.
	 */
	approveExecute(trigger: () => Promise<void>): Promise<Page>
	/**
	 * Imports a token by address from Home's token menu. Resolves with the wallet's answer: its
	 * "Token added", or the error it shows, after which the import dialog is dismissed.
	 */
	importToken(address: string): Promise<{ added: true } | { refused: string }>
	/** The total Home shows on `symbol`'s card once its balance settled. */
	tokenTotal(symbol: string): Promise<string>
	/** The popup document, opened in a tab (a toolbar popup is unreachable in headless Chromium). */
	popup(): Page
}

const STEP_MS = 60_000
/** Fee estimates and authwit previews run before the execute window allows Confirm. */
const APPROVABLE_MS = 5 * 60_000
const CELLS = 9

const input = (page: Page, testId: string) => page.getByTestId(testId).locator("input")

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The wallet appends U+FE0F to a lone text-capable pictograph for display; the app does not. */
export function emojiCells(text: string): string[] {
	return Array.from(graphemes.segment(text.replace(/\s/g, "").replaceAll("️", "")), (s) => s.segment)
}

/** Enabled and clickable: the wallet also disables its buttons with `pointer-events: none`. */
async function untilClickable(page: Page, testId: string, timeout: number): Promise<void> {
	await expect
		.poll(
			() =>
				page
					.getByTestId(testId)
					.evaluate((b) => !(b as HTMLButtonElement).disabled && getComputedStyle(b).pointerEvents !== "none")
					.catch(() => false),
			{ message: `the wallet's ${testId} became clickable`, timeout },
		)
		.toBe(true)
}

async function closed(page: Page): Promise<void> {
	if (!page.isClosed()) await page.waitForEvent("close", { timeout: STEP_MS })
}

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
	/** A wait for the wallet's next `kind` window, to arm before the action that opens it. */
	const nextWindow = (kind: string, timeout = STEP_MS) =>
		context.waitForEvent("page", { predicate: (p) => p.url().startsWith(`${origin}/src/popup/index.html#/windows/${kind}`), timeout })

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

		async connect(app) {
			// The wallet answers the app's discovery only after Allow, and the app stops listening after 15 s.
			const discovering = nextWindow("discover")
			await app.getByTestId("connect-button").click()
			const discover = await discovering
			const verifying = nextWindow("verify", 2 * STEP_MS)
			await untilClickable(discover, "discover-allow-btn", STEP_MS)
			await discover.getByTestId("discover-allow-btn").click()
			const option = app.getByTestId("wallet-option").filter({ hasText: "Extension" })
			await expect(option, "the app lists exactly one extension wallet").toHaveCount(1)
			await option.click()
			const verify = await verifying
			await expect(app.getByTestId("emoji-cell")).toHaveCount(CELLS)
			const appGrid = (await app.getByTestId("emoji-cell").allTextContents()).flatMap(emojiCells)
			await expect(verify.getByTestId("verify-emoji-grid")).toBeVisible({ timeout: STEP_MS })
			const walletGrid = emojiCells(await verify.getByTestId("verify-emoji-grid").innerText())
			expect(walletGrid, "the wallet's verify window shows the app's nine symbols in order").toEqual(appGrid)
			await untilClickable(verify, "verify-confirm-btn", STEP_MS)
			await verify.getByTestId("verify-confirm-btn").click()
			await closed(verify)
			const granting = nextWindow("capabilities")
			await app.getByTestId("emoji-confirm").click()
			const grant = await granting
			const account = grant.getByTestId("cap-account-item").first()
			await account.waitFor({ timeout: STEP_MS })
			// The wallet preselects a lone account, and a second click would deselect it.
			if ((await account.getAttribute("data-selected")) === null) await account.click()
			await untilClickable(grant, "cap-approve-btn", STEP_MS)
			await grant.getByTestId("cap-approve-btn").click()
			await closed(grant)
			return appGrid
		},

		async approveExecute(trigger) {
			const opening = nextWindow("execute", STEP_MS)
			await trigger()
			const execute = await opening
			await execute.getByTestId("execute-op-item").first().waitFor({ timeout: STEP_MS })
			await untilClickable(execute, "execute-confirm-btn", APPROVABLE_MS)
			await execute.getByTestId("execute-confirm-btn").click()
			return execute
		},

		async importToken(address) {
			const page = this.popup()
			await goHash(page, "#/popup/general")
			await page.getByTestId("tokens-menu-trigger").click({ timeout: STEP_MS })
			await page.getByTestId("tokens-menu-import").click()
			await input(page, "token-address-input").fill(address)
			await untilClickable(page, "import-token-button", STEP_MS)
			await page.getByTestId("import-token-button").click()
			const added = page.getByText("Token added")
			const refused = page.getByTestId("new-token-error")
			await expect(added.or(refused).first(), "the wallet answered the import").toBeVisible({ timeout: STEP_MS })
			if (await added.isVisible()) return { added: true }
			const message = ((await refused.textContent()) ?? "").trim()
			await page.keyboard.press("Escape")
			return { refused: message }
		},

		async tokenTotal(symbol) {
			const page = this.popup()
			await goHash(page, "#/popup/general")
			const card = page.locator(`[data-testid="tokens-card"]:has([data-testid="token-symbol"][data-symbol="${symbol}"])`)
			await expect(card.getByTestId("token-balance-loading")).toHaveCount(0, { timeout: STEP_MS })
			return ((await card.getByTestId("token-amount").textContent({ timeout: STEP_MS })) ?? "").trim()
		},

		popup() {
			if (!popupPage) throw new Error("driver: onboard() opens the popup first")
			return popupPage
		},
	}
}
