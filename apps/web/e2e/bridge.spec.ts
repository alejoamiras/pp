/**
 * The bridge on a stack build, against the local stack's seeded pool: a real proof in the page, the
 * spend sent from a separate Ethereum account (the injected wallet switched to the stack's sender, or
 * the build's own demo sender), and the claim sent through the test wallet from a fresh Aztec account,
 * paid by the SponsoredFPC. The tests share the stack's pool, so each picks the first note with value
 * left; the last one sends nothing, so the pool spec still finds both labels. Payer: anvil's dev accounts
 * and the SponsoredFPC. Estimated 4 min, measured 3.4 min on a 192-core host, the actors' setup included.
 */
import type { Page } from "@playwright/test"
import { anvilKey } from "@pp/bridge-core/sandbox"
import { deriveClaimKey, deriveClaimSalt } from "@pp/bridge-spec"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { DEMO_SENDER_ADDRESS } from "@pp/local-stack/seed"
import { messageOf } from "../src/data/errors"
import { formatAmount, plainAmount } from "../src/ui/format"
import { approvedNote, seededStack } from "./stack"
import { connectWallet, signInToPool, submitted, watchPage } from "./support"

test.use({ family: "bridge", cells: 3, spares: 0 })
test.skip(({ run }) => run.mode !== "stack", "the sandbox build bridges in the fixture world, which the unit suite covers")

/**
 * About five times the slowest step measured on a 192-core host: proving through mined 5.3 to 8.3 s,
 * mined to claimable 1.4 to 1.9 s, the actor's deployment with the claim 10.6 to 18.8 s.
 */
const WAIT = { mined: 45_000, claimable: 15_000, claimed: 90_000 }

let last = 0
/** Logs how long each step took since the previous one (`start` resets), so the waits stay sized from measurements. */
function step(name: string): void {
	const now = Date.now()
	if (name !== "start") console.log(`[bridge-spec] ${name}: ${((now - last) / 1000).toFixed(2)} s`)
	last = now
}

/** The bridge form of `commitment`'s row with `amount` typed in. */
async function openForm(page: Page, commitment: bigint, amount: string) {
	await page.locator(`[data-testid="note-row"][data-commitment="${commitment}"]`).getByRole("button", { name: "Bridge to Aztec" }).click()
	const form = page.getByTestId("bridge-form")
	await form.getByLabel(/Amount to bridge/).fill(amount)
	return form
}

/** Every value the page's storage holds, keys included, lower-cased. */
const storageText = (page: Page) =>
	page.evaluate(() =>
		Object.entries(localStorage)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n")
			.toLowerCase(),
	)

// Fails if the page's proof, the injected wallet's send, the claim through the Aztec wallet or the
// label's balance breaks in the browser; if a wallet's no reads as anything but a rejection; or if the
// stored record holds a nullifier, a claim salt or the sign-in signature in the clear.
test("bridges a pool note, claims it on Aztec and shows the balance under its label; the stored record holds no secret", async ({
	page,
	run,
	actor,
	l1,
}) => {
	test.setTimeout(240_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const amount = (note.value * 7n) / 10n
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const screen = page.getByTestId("bridge-screen")

	await page.goto("/")
	await l1.setAccount(anvilKey(s.stack.accounts.user.index))
	await signInToPool(page)
	const frame = await connectWallet(page, wallet)
	await l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	const form = await openForm(page, note.commitment, plainAmount(amount, s.decimals))
	await expect(form.getByLabel(`Amount to bridge (${s.symbol})`)).toBeVisible()
	const before = await storageText(page)
	// The wallet's no reaches the page as a rejection: nothing sent, the record dropped, the form back.
	l1.rejectNext("transaction")
	step("start")
	await form.getByRole("button", { name: "Bridge to Aztec" }).click()
	await expect(form.getByText(messageOf("WALLET_REJECTED"))).toBeVisible({ timeout: WAIT.mined })
	step("declined")
	expect(await storageText(page), "the declined send left no record").toBe(before)
	await form.getByRole("button", { name: "Bridge to Aztec" }).click()
	await expect(screen).toHaveAttribute("data-step", /mined|claimable/, { timeout: WAIT.mined })
	step("mined")

	const stored = await storageText(page)
	expect(stored, "the bridge left a record").not.toBe(before)
	const nullifier = await s.pool.nullifierOf(note.commitment)
	const salt = deriveClaimSalt(deriveClaimKey(s.signature, s.owner), note.commitment)
	const secrets = { nullifier, salt }
	for (const [name, v] of Object.entries(secrets)) {
		expect(stored, `${name} in decimal`).not.toContain(v.toString())
		expect(stored, `${name} in hex`).not.toContain(v.toString(16).padStart(64, "0"))
	}
	expect(stored, "the sign-in signature").not.toContain(s.signature.slice(2, 66).toLowerCase())

	await expect(screen).toHaveAttribute("data-step", "claimable", { timeout: WAIT.claimable })
	step("claimable")
	await screen.getByRole("button", { name: "Claim on Aztec" }).click()
	await expect(screen).toHaveAttribute("data-step", "claimed", { timeout: WAIT.claimed })
	step("claimed")
	expect(await submitted(frame)).toHaveLength(1)

	await screen.getByRole("button", { name: "Back to balances" }).last().click()
	const labelRow = page.locator(`[data-testid="label-row"][data-label="${note.label}"]`)
	await expect(labelRow).toContainText(formatAmount(amount, s.decimals, 2), { timeout: 30_000 })
	await watch.clean()
})

// Fails if a bridge sent before a reload is not found again from the journal and the chain, or cannot be
// claimed from the new page; or if the demo sender's spend reaches the injected wallet.
test("a reload mid-bridge picks the bridge up again and claims it; the local dev account sent it, not the wallet", async ({
	page,
	run,
	actor,
	l1,
}) => {
	test.setTimeout(240_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const amount = (note.value * 7n) / 10n
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const screen = page.getByTestId("bridge-screen")

	await page.goto("/")
	await l1.setAccount(anvilKey(s.stack.accounts.user.index))
	await signInToPool(page)
	await connectWallet(page, wallet)
	const form = await openForm(page, note.commitment, plainAmount(amount, s.decimals))
	await form.getByRole("button", { name: "Send from the local dev account" }).click()
	await expect(form.getByTestId("demo-sender")).toContainText(DEMO_SENDER_ADDRESS)
	const walletSends = l1.calls("eth_sendTransaction")
	step("start")
	await form.getByRole("button", { name: "Bridge to Aztec" }).click()
	await expect(screen).toHaveAttribute("data-step", /submitted|mined|claimable/, { timeout: WAIT.mined })
	step("sent")
	expect(l1.calls("eth_sendTransaction"), "the injected wallet was asked to send").toBe(walletSends)

	await page.reload()
	await signInToPool(page)
	const frame = await connectWallet(page, wallet)
	const record = page.getByTestId("bridge-record").filter({ hasText: formatAmount(amount, s.decimals, 2) })
	await record.getByRole("button", { name: "Open" }).click()
	await expect(screen).toHaveAttribute("data-step", "claimable", { timeout: WAIT.claimable })
	step("claimable after reload")
	await screen.getByRole("button", { name: "Claim on Aztec" }).click()
	await expect(screen).toHaveAttribute("data-step", "claimed", { timeout: WAIT.claimed })
	step("claimed")
	expect(await submitted(frame)).toHaveLength(1)
	await watch.clean()
})

// Fails if a send the wallet never answered, with no hash in the journal, comes back after a reload as
// anything but the uncertain state, or offers a fresh Bridge beside Check again and Send again.
test("a reload while the wallet holds the send unanswered offers only Check again or Send again on the note", async ({
	page,
	run,
	actor,
	l1,
}) => {
	test.setTimeout(180_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const

	await page.goto("/")
	await l1.setAccount(anvilKey(s.stack.accounts.user.index))
	await signInToPool(page)
	await connectWallet(page, wallet)
	await l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	const form = await openForm(page, note.commitment, plainAmount((note.value * 7n) / 10n, s.decimals))
	l1.holdNext("transaction")
	step("start")
	await form.getByRole("button", { name: "Bridge to Aztec" }).click()
	await expect.poll(() => l1.holdsArmed(), { timeout: WAIT.mined }).toBe(0)
	step("held")

	await page.reload()
	await l1.setAccount(anvilKey(s.stack.accounts.user.index))
	await signInToPool(page)
	await connectWallet(page, wallet)
	await l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	const row = page.locator(`[data-testid="note-row"][data-commitment="${note.commitment}"]`)
	await expect(row.getByText("We can't see your transaction yet")).toBeVisible({ timeout: 30_000 })
	await expect(row.getByRole("button")).toHaveText(["Check again", "Send again"])
	await watch.clean()
})
