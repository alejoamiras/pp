/**
 * What the web specs share: the watch every test ends on (zero CSP violations, zero page errors), the
 * wallet frame and its control hook, the connect flow and the pool sign-in. A function
 * passed to `evaluate` runs in the page, so each one reaches its hook on its own.
 */
import type { Frame, Page } from "@playwright/test"
import { expect } from "@pp/e2e-kit/fixtures/test.ts"
import type { TestWalletControl } from "@pp/e2e-kit/test-wallet/globals"

declare global {
	interface Window {
		__ppCspViolations?: string[]
	}
}

export type Profile = "plain" | "full"

export interface Watch {
	/** Expects no violation since the last navigation and no page error since the watch began. */
	clean(): Promise<void>
}

/** Collects every policy violation each document reports from its first script on, and every page error. */
export async function watchPage(page: Page): Promise<Watch> {
	await page.addInitScript(() => {
		window.__ppCspViolations = []
		document.addEventListener("securitypolicyviolation", (e) => {
			window.__ppCspViolations?.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)
		})
	})
	const errors: string[] = []
	page.on("pageerror", (err) => errors.push(err.message))
	return {
		async clean() {
			expect(await page.evaluate(() => window.__ppCspViolations), "CSP violations").toEqual([])
			expect(errors, "page errors").toEqual([])
		},
	}
}

/** The wallet document at `origin`. Discovery probes leave once answered, so the last one is the session's. */
export function walletFrame(page: Page, origin: string): Frame {
	const frame = page
		.frames()
		.filter((f) => f.url().startsWith(`${origin}/`))
		.at(-1)
	if (!frame) throw new Error(`no frame at ${origin}; frames: ${page.frames().map((f) => f.url())}`)
	return frame
}

/** Every transaction the wallet in `frame` handed the node since it booted. */
export function submitted(frame: Frame): ReturnType<TestWalletControl["submitted"]> {
	return frame.evaluate(() => {
		const control = window.__ppTestWallet
		if (!control) throw new Error("the wallet frame exposes no __ppTestWallet")
		return control.submitted()
	})
}

/** Arms the session frame's wallet: its next grant leaves out the contract scope. */
export function declineNextGrant(frame: Frame): Promise<void> {
	return frame.evaluate(() => {
		const control = window.__ppTestWallet
		if (!control) throw new Error("the wallet frame exposes no __ppTestWallet")
		return control.declineNextGrant()
	})
}

export interface WalletChoice {
	profile: Profile
	origin: string
	/** An account the grant must list. */
	account: string
	/** Runs while the emoji grid shows: the session frame exists and has not been asked for its grant. */
	whileVerifying?: (frame: Frame) => Promise<void>
}

export const walletOption = (page: Page, profile: Profile) =>
	page.locator(`[data-testid="wallet-option"][data-wallet-id="test-wallet-${profile}"]`)

/** Opens the connect dialog and connects `o.profile`; returns the session frame. */
export async function connectWallet(page: Page, o: WalletChoice): Promise<Frame> {
	await page.getByTestId("connect-button").click()
	return chooseWallet(page, o)
}

/** From the open dialog: the secure channel, the emoji check, then the granted account. */
export async function chooseWallet(page: Page, o: WalletChoice): Promise<Frame> {
	await walletOption(page, o.profile).click()
	await expect(page.getByTestId("emoji-cell")).toHaveCount(9)
	const frame = walletFrame(page, o.origin)
	await o.whileVerifying?.(frame)
	await page.getByTestId("emoji-confirm").click()
	await expect(page.locator(`[data-testid="aztec-account"][data-address="${o.account.toLowerCase()}"]`)).toBeVisible()
	return frame
}

/** The bridge form of `commitment`'s row with `amount` typed in. */
export async function openForm(page: Page, commitment: bigint, amount: string) {
	await page.locator(`[data-testid="note-row"][data-commitment="${commitment}"]`).getByRole("button", { name: "Bridge to Aztec" }).click()
	const form = page.getByTestId("bridge-form")
	await form.getByLabel(/Amount to bridge/).fill(amount)
	return form
}

/** Signs in to the pool as the Ethereum wallet's selected account, its owner, and waits for a note. */
export async function signInToPool(page: Page): Promise<void> {
	await page.getByTestId("eth-sign-in").click()
	await expect(page.getByTestId("note-row").first()).toBeVisible()
}
