/**
 * Connect, on the production bundle against the sandbox: the wallet SDK, its iframe, cross-origin
 * isolation and the CSP working together, which jsdom cannot show. Payer: none; the connect grants
 * accounts only, and the wallet frame reports that it handed the node no transaction.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Frame, Page } from "@playwright/test"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import type { TestWalletControl } from "@pp/e2e-kit/test-wallet/globals"

test.use({ family: "connect", cells: 1, spares: 0 })

declare global {
	interface Window {
		__ppCspViolations?: string[]
	}
}

/** Every policy violation the document reports, from its first script on. */
async function collectCspViolations(page: Page): Promise<void> {
	await page.addInitScript(() => {
		window.__ppCspViolations = []
		document.addEventListener("securitypolicyviolation", (e) => {
			window.__ppCspViolations?.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)
		})
	})
}

function walletFrame(page: Page, origin: string): Frame {
	const frame = page.frames().find((f) => f.url().startsWith(`${origin}/`))
	if (!frame) throw new Error(`no frame at ${origin}; frames: ${page.frames().map((f) => f.url())}`)
	return frame
}

/** Every transaction the wallet in `frame` handed the node since it booted. */
function submitted(frame: Frame): ReturnType<TestWalletControl["submitted"]> {
	return frame.evaluate(() => {
		const control = window.__ppTestWallet
		if (!control) throw new Error("the wallet frame exposes no __ppTestWallet")
		return control.submitted()
	})
}

test("connects the plain wallet in an isolated page and frame, under the CSP, sending nothing", async ({ page, run, actor }) => {
	await collectCspViolations(page)
	const pageErrors: string[] = []
	page.on("pageerror", (err) => pageErrors.push(err.message))

	const response = await page.goto("/")
	const served = response?.headers() ?? {}
	const built = JSON.parse(readFileSync(join(run.appDist, "security-headers.json"), "utf8")) as Record<string, string>
	expect(served["cross-origin-opener-policy"]).toBe("same-origin")
	expect(served["cross-origin-embedder-policy"]).toBe("require-corp")
	expect(served["content-security-policy"]).toBe(built["Content-Security-Policy"])
	expect(served["content-security-policy"]).toContain(`frame-src ${run.testWalletOrigins.plain} ${run.testWalletOrigins.full}`)
	expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)

	await page.getByTestId("connect-button").click()
	await page.locator('[data-testid="wallet-option"][data-wallet-id="test-wallet-plain"]').click()
	await expect(page.getByTestId("emoji-cell")).toHaveCount(9)
	await page.getByTestId("emoji-confirm").click()
	await expect(page.locator(`[data-testid="aztec-account"][data-address="${actor.address.toLowerCase()}"]`)).toBeVisible()

	const frame = walletFrame(page, run.testWalletOrigins.plain)
	expect(await frame.evaluate(() => crossOriginIsolated)).toBe(true)
	expect(await submitted(frame)).toEqual([])

	expect(await page.evaluate(() => window.__ppCspViolations)).toEqual([])
	expect(pageErrors).toEqual([])
})
