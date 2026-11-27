/**
 * The label row's withdrawal on a stack build, against the local stack: a bridge sent from the build's
 * demo sender and claimed through the test wallet puts one note under the pool note's label on a fresh
 * Aztec account; once the label is checked, the page sends part of it to a fresh payee through the hub's
 * private exit in the same wallet, lists the public ticket from the chain and collects it from the
 * injected wallet's separate sender. Payer: anvil's dev accounts and the SponsoredFPC. Estimated 90–150 s,
 * measured 54 s alone on a 192-core host, the actor's setup not counted.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { computeFeePayerBalanceLeafSlot } from "@aztec-labs/protocol-contracts/fee-juice"
import { createBridgeClient, type KeyValueStore } from "@pp/bridge-core"
import { anvilKey } from "@pp/bridge-core/sandbox"
import type { Locator } from "@playwright/test"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { createPublicClient, erc20Abi, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { sponsoredFpcAddress } from "../src/build/sponsored-fpc"
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

// Fails if the page's private exit (the sponsor, then the hub's exit_private with the checked path) does
// not go through the wallet SDK and the test wallet, if the landed transaction publishes any public log
// but the hub's ticket, names the Aztec account in one or writes public data beyond the sponsor's fee
// balance, or if the ticket does not settle on the real portal through Exits. The unit suite checks the payload's shape against fakes only.
test("withdraws part of a checked label to a fresh payee through the private exit and collects it on Ethereum", async ({
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
	const node = createAztecNodeClient(s.manifest.aztecNode)
	const hash = TxHash.fromString(sent[1]?.hash ?? "")
	expect((await node.getTxReceipt(hash)).hasExecutionSucceeded(), "the exit's public check passed").toBe(true)
	const effect = await node.getTxEffect(hash)
	if (!effect) throw new Error("the node has no effect for the withdrawal")
	const logs = effect.data.publicLogs
	expect(
		logs.map((l) => l.contractAddress.toString().toLowerCase()),
		"the hub's ticket is the only public log",
	).toEqual([s.manifest.bridge.hub.toLowerCase()])
	for (const l of logs)
		expect(
			l.fields.map((f) => f.toBigInt()),
			"no log names the account",
		).not.toContain(BigInt(actor.address))
	const feeLeaf = await computeFeePayerBalanceLeafSlot(AztecAddress.fromStringUnsafe(await sponsoredFpcAddress()))
	const writes = effect.data.publicDataWrites
	expect(writes.length, "the sponsor's fee is written").toBeGreaterThan(0)
	expect(
		writes.every((w) => w.leafSlot.equals(feeLeaf)),
		"the sponsor's fee balance is the only public write",
	).toBe(true)

	const client = createBridgeClient({ manifest: s.manifest, journal: memoryJournal() })
	const [ticket, ...none] = await client.exitTickets({ payee })
	expect(none, "one ticket to the payee").toEqual([])
	expect(ticket).toMatchObject({ kind: "public", payee, amount: withdrawn })
	if (!ticket) throw new Error("no ticket")
	expect(ticket.l2TxHash.toLowerCase(), "the ticket is the withdrawal's").toBe(sent[1]?.hash.toLowerCase())

	await dialog.getByRole("button", { name: "Close" }).click()
	// The whole figure, which a read from before the send cannot show: the change kept the label.
	await expect(amountOf(row)).toHaveText(`${formatAmount(amount - withdrawn, s.decimals, 2)}${s.symbol}`, {
		timeout: WAIT.read,
	})
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
