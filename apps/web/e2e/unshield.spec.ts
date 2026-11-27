/**
 * The unshield on a stack build, against the local stack: a bridge sent from the build's demo sender
 * and claimed through the test wallet puts one note under the pool note's label on a fresh Aztec
 * account; the page checks the label against the bot's snapshot in its worker and unshields part of
 * it through the same wallet with the path that check read. Payer: anvil's dev accounts and the
 * SponsoredFPC. Estimated 3 min, measured 44 s alone and inside the suite on a 192-core host, the
 * actor's setup not counted.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { formatAmount, plainAmount } from "../src/ui/format"
import { approvedNote, seededStack } from "./stack"
import { bridgeAndClaim, stepLog, submitted, watchPage } from "./support"

test.use({ family: "unshield", cells: 1, spares: 0 })
test.skip(({ run }) => run.mode !== "stack", "the sandbox build unshields in the fixture world, which the unit suite covers")

/**
 * The bridge's and the claim's waits are the ragequit spec's. Measured alone on a 192-core host: the
 * label's check 2.5 s from the claimed balance, the unshield 6 s, both balances read back 2 s.
 */
const WAIT = { claimable: 60_000, claimed: 90_000, active: 30_000, sent: 60_000, read: 30_000 }
const step = stepLog("unshield-spec")

// Fails if the page cannot download and check the bot's snapshot in its worker under the CSP, if the
// path it reads is not one the token accepts at the block the wallet proves against, if the unshield's
// public step reverts, or if the public balance is not read back through the wallet's grant. The unit
// suite fakes all four.
test("unshields part of a claimed label with the path its allow-list check read, into the public balance", async ({
	page,
	run,
	actor,
	l1,
}) => {
	test.setTimeout(300_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const amount = (note.value * 7n) / 10n
	const unshielded = amount / 2n
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const { frame, row } = await bridgeAndClaim(page, { s, note, amount, wallet, l1, step, wait: WAIT })

	await expect(row).toHaveAttribute("data-state", "ACTIVE", { timeout: WAIT.active })
	step("label active")
	await row.getByRole("button", { name: "Unshield" }).click()
	const dialog = page.getByTestId("action-dialog")
	await dialog.getByLabel(/Amount/).fill(plainAmount(unshielded, s.decimals))
	step("start")
	await dialog.getByRole("button", { name: "Unshield" }).click()
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: WAIT.sent })
	step("unshield sent")
	const sent = await submitted(frame)
	expect(sent, "the claim and the unshield, each once").toHaveLength(2)
	const receipt = await createAztecNodeClient(s.manifest.aztecNode).getTxReceipt(TxHash.fromString(sent[1]?.hash ?? ""))
	expect(receipt.hasExecutionSucceeded(), "the unshield's public step ran").toBe(true)

	await dialog.getByRole("button", { name: "Close" }).click()
	await expect(page.getByTestId("public-row")).toContainText(formatAmount(unshielded, s.decimals, 2), { timeout: WAIT.read })
	await expect(row).toContainText(formatAmount(amount - unshielded, s.decimals, 2), { timeout: WAIT.read })
	step("balances read")
	await watch.clean()
})
