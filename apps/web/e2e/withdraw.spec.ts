/**
 * The label row's withdrawal on a stack build, against the local stack: a bridge sent from the build's
 * demo sender and claimed through the test wallet puts one note under the pool note's label on a fresh
 * Aztec account; once the label is checked, the page unshields part of it and exits it to a fresh payee
 * in one transaction through the same wallet, lists the public ticket from the chain and collects it from
 * the injected wallet's separate sender. Payer: anvil's dev accounts and the SponsoredFPC. Estimated
 * 90–150 s, measured 1.2 min alone on a 192-core host (the withdrawal 12 s), the actor's setup not counted.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { createBridgeClient, type KeyValueStore } from "@pp/bridge-core"
import { anvilKey } from "@pp/bridge-core/sandbox"
import type { Locator } from "@playwright/test"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { createPublicClient, erc20Abi, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { formatAmount, plainAmount } from "../src/ui/format"
import { approvedNote, seededStack } from "./stack"
import { bridgeAndClaim, stepLog, submitted, watchPage } from "./support"

test.use({ family: "withdraw", cells: 1, spares: 0 })
test.skip(({ run }) => run.mode !== "stack", "the sandbox build withdraws in the fixture world, which the unit suite covers")

/** The bridge's, the claim's and the collect's waits are the ragequit spec's; the label's check is the unshield spec's. */
const WAIT = { claimable: 60_000, claimed: 90_000, active: 30_000, sent: 60_000, read: 30_000, ready: 180_000, settled: 30_000 }
const step = stepLog("withdraw-spec")

/** A row's amount, which `Amount` renders as the figure followed by the symbol in a `small`. */
const amountOf = (row: Locator) => row.locator("span:has(> small)")

function memoryJournal(): KeyValueStore {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

// Fails if the page's three-call payload (the sponsor, the checked unshield, the hub's exit_public) does
// not go through the wallet SDK and the test wallet as one transaction, if its public credit does not
// run before its burn, or if a public ticket the page sent does not settle on the real portal through
// Exits. The unit suite checks the payload's shape against fakes only.
test("withdraws part of a checked label to a fresh payee in one transaction and collects it on Ethereum", async ({
	page,
	run,
	actor,
	l1,
}) => {
	test.setTimeout(420_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const amount = (note.value * 7n) / 10n
	const withdrawn = amount / 2n
	const payee = privateKeyToAccount(generatePrivateKey()).address
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const { frame, row } = await bridgeAndClaim(page, { s, note, amount, wallet, l1, step, wait: WAIT })

	await expect(row).toHaveAttribute("data-state", "ACTIVE", { timeout: WAIT.active })
	step("label active")
	await row.getByRole("button", { name: "Withdraw to Ethereum" }).click()
	const dialog = page.getByTestId("action-dialog")
	await dialog.getByLabel(/Amount/).fill(plainAmount(withdrawn, s.decimals))
	await dialog.getByLabel("Payee on Ethereum").fill(payee)
	await dialog.getByRole("button", { name: "Review" }).click()
	const review = dialog.getByTestId("exit-review")
	await expect(review).toContainText(payee)
	await expect(review).toContainText(`${plainAmount(withdrawn, s.decimals)} ${s.symbol}`)
	step("start")
	await review.getByRole("button", { name: "Withdraw to Ethereum" }).click()
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: WAIT.sent })
	step("withdrawal sent")
	const sent = await submitted(frame)
	expect(sent, "the claim and the withdrawal, each once").toHaveLength(2)
	const receipt = await createAztecNodeClient(s.manifest.aztecNode).getTxReceipt(TxHash.fromString(sent[1]?.hash ?? ""))
	expect(receipt.hasExecutionSucceeded(), "the unshield's credit ran before the exit's burn").toBe(true)

	const client = createBridgeClient({ manifest: s.manifest, journal: memoryJournal() })
	const [ticket, ...none] = await client.exitTickets({ payee })
	expect(none, "one ticket to the payee").toEqual([])
	expect(ticket).toMatchObject({ kind: "public", payee, amount: withdrawn })
	if (!ticket) throw new Error("no ticket")
	expect(ticket.l2TxHash.toLowerCase(), "the ticket is the withdrawal's").toBe(sent[1]?.hash.toLowerCase())

	await dialog.getByRole("button", { name: "Close" }).click()
	// Whole figures: a substring match would find 0.00 in 10.00 and 0.005.
	const shown = (v: bigint) => `${formatAmount(v, s.decimals, 2)}${s.symbol}`
	await expect(amountOf(row)).toHaveText(shown(amount - withdrawn), { timeout: WAIT.read })
	// The credit and the burn cancel out.
	await expect(amountOf(page.getByTestId("public-row"))).toHaveText(shown(0n), { timeout: WAIT.read })
	step("balances read")

	await page.getByRole("button", { name: "Exits" }).click()
	const deployment = `${s.manifest.chainId}:${s.manifest.bridge.portal}:${s.manifest.bridge.hub}`.toLowerCase()
	const exit = page.locator(`[data-testid="exit-row"][data-key="${deployment}:${ticket.l2TxHash}:${ticket.messageIndexInTx}"]`)
	await expect(exit).toHaveAttribute("data-status", "ready", { timeout: WAIT.ready })
	step("ticket ready")
	await l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	await exit.getByRole("button", { name: "Collect on Ethereum" }).click()
	await page.getByTestId("collect-review").getByRole("button", { name: "Collect", exact: true }).click()
	await expect(exit).toHaveAttribute("data-status", "settled", { timeout: WAIT.settled })
	step("collected")

	const reads = createPublicClient({ transport: http(s.manifest.l1Rpc) })
	const paid = await reads.readContract({ address: s.manifest.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [payee] })
	expect(paid, "the payee holds exactly the withdrawal").toBe(withdrawn)
	await watch.clean()
})
