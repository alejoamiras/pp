/**
 * The shield on a stack build, against the local stack, through the bot's approval and a private send.
 * Payer: anvil's dev accounts and the SponsoredFPC. Estimated 90 to 120 s, measured 1.5 min alone on a
 * 192-core host, the actors' setup not counted.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import type { PoolNoteView } from "@pp/pool-client"
import { formatAmount, plainAmount } from "../src/ui/format"
import { seededStack } from "./stack"
import { amountOf, bridgeAndClaim, stepLog, submitted, watchPage } from "./support"

test.use({ family: "shield", cells: 2, spares: 0 })
test.skip(({ run }) => run.mode !== "stack", "the sandbox build shields in the fixture world, which the unit suite covers")

/**
 * The claim's waits are the unshield spec's. `approved` is the stack births case's bound: the bot ticks
 * on each Aztec block and at least every 30 s. Measured alone on a 192-core host: the shield 14 s, its
 * approval read on the page 13 s, the transfer 10 s.
 */
const WAIT = { claimable: 60_000, claimed: 90_000, active: 30_000, sent: 60_000, read: 30_000, approved: 180_000 }
const step = stepLog("shield-spec")

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Fails if the wallet's execution refuses the stage's grant or the shield's payload, if the bot never
// approves the birth or the page's refetch does not show it without a reload, or if the token refuses
// the birth-tree path the page's worker read in a checked private transfer. The unit suite fakes all
// three; the test wallet does not prove, so real proving is the real-wallet tier's.
test("shields part of the public balance into a new label that turns Funds enabled once approved, then sends from it privately", async ({
	page,
	run,
	actor,
	pool,
	l1,
}) => {
	test.setTimeout(420_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	// The stack seeds two notes of 100 base units, and the other specs bridge 70% of the first approved
	// note at a time: after the three bridges ahead of this file the largest still holds 30 or more, and
	// halving its 70% three times needs 12.
	const note = (await s.pool.notes())
		.filter((n) => n.status === "approved" && n.value > 0n)
		.reduce<PoolNoteView | undefined>((best, n) => (best && best.value >= n.value ? best : n), undefined)
	if (!note) throw new Error("the stack holds no approved note with value left")
	// Every amount here is below 100 base units, so it has at most two significant digits, which the page
	// prints in full: each balance it shows is the exact amount.
	const shown = (v: bigint) => new RegExp(`^${literal(formatAmount(v, s.decimals, 2))}\\s*${literal(s.symbol)}$`)
	const amount = (note.value * 7n) / 10n
	const unshielded = amount / 2n
	const shielded = unshielded / 2n
	const sent = shielded / 2n
	expect(sent, "the note splits in half three times").toBeGreaterThan(0n)
	const other = pool.take()
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const { frame, row } = await bridgeAndClaim(page, { s, note, amount, wallet, l1, step, wait: WAIT })
	// The page acts as the first account the grant lists; the other one receives.
	const actors = [actor.address, other.address].map((a) => a.toLowerCase())
	const sender = await page.getByTestId("aztec-account").first().getAttribute("data-address")
	expect(actors, "the page acts as one of the file's two accounts").toContain(sender)
	const recipient = actors.find((a) => a !== sender)

	const dialog = page.getByTestId("action-dialog")
	const publicRow = page.getByTestId("public-row")
	await expect(row).toHaveAttribute("data-state", "ACTIVE", { timeout: WAIT.active })
	await row.getByRole("button", { name: "Unshield" }).click()
	await dialog.getByLabel(/Amount/).fill(plainAmount(unshielded, s.decimals))
	step("start")
	await dialog.getByRole("button", { name: "Unshield" }).click()
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: WAIT.sent })
	step("unshield sent")
	await dialog.getByRole("button", { name: "Close" }).click()
	await expect(amountOf(publicRow)).toHaveText(shown(unshielded), { timeout: WAIT.read })

	await publicRow.getByRole("button", { name: "Shield", exact: true }).click()
	await dialog.getByLabel(/Amount/).fill(plainAmount(shielded, s.decimals))
	step("start")
	await dialog.getByRole("button", { name: "Shield", exact: true }).click()
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: WAIT.sent })
	step("shield sent")
	await dialog.getByRole("button", { name: "Close" }).click()
	const birth = page.locator(`[data-testid="label-row"]:not([data-label="${note.label}"])`)
	await expect(birth).toHaveCount(1, { timeout: WAIT.read })
	await expect(amountOf(birth)).toHaveText(shown(shielded))
	// The bot may approve before the page's first read, so a correct build can skip "Not enabled yet".
	const seen = new Set<string | null>()
	await expect
		.poll(
			async () => {
				const state = await birth.getAttribute("data-state")
				seen.add(state)
				return state
			},
			{ timeout: WAIT.approved, intervals: [250] },
		)
		.toBe("ACTIVE")
	await expect(birth).toContainText("Funds enabled")
	step(`birth enabled, states seen: ${[...seen].join(" → ")}`)

	await birth.getByRole("button", { name: "Send privately" }).click()
	await dialog.getByLabel("Recipient on Aztec").fill(recipient ?? "")
	await dialog.getByLabel(/Amount/).fill(plainAmount(sent, s.decimals))
	step("start")
	await dialog.getByRole("button", { name: "Send", exact: true }).click()
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: WAIT.sent })
	step("transfer sent")

	const txs = await submitted(frame)
	expect(txs, "the claim, the unshield, the shield and the transfer, each once").toHaveLength(4)
	expect(new Set(txs.map((tx) => tx.hash)).size, "four distinct transactions").toBe(4)
	const node = createAztecNodeClient(s.manifest.aztecNode)
	for (const tx of txs) expect((await node.getTxReceipt(TxHash.fromString(tx.hash))).hasExecutionSucceeded(), tx.hash).toBe(true)

	await dialog.getByRole("button", { name: "Close" }).click()
	await expect(amountOf(publicRow)).toHaveText(shown(unshielded - shielded), { timeout: WAIT.read })
	await expect(amountOf(birth)).toHaveText(shown(shielded - sent), { timeout: WAIT.read })
	await expect(amountOf(row)).toHaveText(shown(amount - unshielded), { timeout: WAIT.read })
	step("balances read")
	await watch.clean()
})
