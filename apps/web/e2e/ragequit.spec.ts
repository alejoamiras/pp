/**
 * The ragequit on a stack build, against the local stack: a bridge sent from the build's demo sender
 * and claimed through the test wallet puts one note under the pool note's label on a fresh Aztec
 * account; the page leaves it to Ethereum through the same wallet, lists its ticket from the chain and
 * collects it from the injected wallet's separate sender to a fresh payee. Payer: anvil's dev accounts
 * and the SponsoredFPC. Estimated 3 min, measured 1.0 min alone and 1.5 min inside the suite on a
 * loaded 192-core host, the actor's setup not counted.
 */
import { createBridgeClient, type KeyValueStore } from "@pp/bridge-core"
import { anvilKey } from "@pp/bridge-core/sandbox"
import { expect, test } from "@pp/e2e-kit/fixtures/test.ts"
import { createPublicClient, erc20Abi, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { approvedNote, seededStack } from "./stack"
import { bridgeAndClaim, stepLog, submitted, watchPage } from "./support"

test.use({ family: "ragequit", cells: 1, spares: 0 })
test.skip(({ run }) => run.mode !== "stack", "the sandbox build exits in the fixture world, which the unit suite covers")

/**
 * About five times the slowest step measured on a 192-core host: the bridge to claimable 11 s, the
 * claim 11 s (19 s in the bridge spec), the ragequit 12 s, the collect 2 s. The ticket read ready
 * 1 s after the ragequit; the epoch proof gets the wait bridge-core's exit suite gives it.
 */
const WAIT = { claimable: 60_000, claimed: 90_000, sent: 60_000, ready: 180_000, settled: 30_000 }

const step = stepLog("ragequit-spec")

function memoryJournal(): KeyValueStore {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

// Fails if the hub's ragequit sent through the wallet's grant breaks in the browser bundle, if the page
// cannot list the ticket from the hub's public events or read its Outbox witness under the CSP, if the
// row's key is not the ticket's (deployment, transaction, message index), or if the collect through the
// injected wallet's guarded client does not pay the payee on Ethereum. The unit suite fakes all four.
test("leaves a claimed label to Ethereum, lists its ticket from the chain and collects it to a fresh payee", async ({
	page,
	run,
	actor,
	l1,
}) => {
	test.setTimeout(360_000)
	const watch = await watchPage(page)
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const amount = (note.value * 7n) / 10n
	const payee = privateKeyToAccount(generatePrivateKey()).address
	const wallet = { profile: "plain", origin: run.testWalletOrigins.plain, account: actor.address } as const
	const { frame, row: labelRow } = await bridgeAndClaim(page, { s, note, amount, wallet, l1, step, wait: WAIT })

	await labelRow.getByRole("button", { name: "Leave to Ethereum (ragequit)" }).click()
	const dialog = page.getByTestId("action-dialog")
	await dialog.getByRole("radio", { name: /Your largest note/ }).check()
	await dialog.getByLabel("Payee on Ethereum").fill(payee)
	await dialog.getByRole("button", { name: "Review" }).click()
	step("start")
	await dialog
		.getByTestId("exit-review")
		.getByRole("button", { name: /^Leave to Ethereum/ })
		.click()
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: WAIT.sent })
	step("ragequit sent")
	expect(await submitted(frame), "the claim and the ragequit, each once").toHaveLength(2)

	const client = createBridgeClient({ manifest: s.manifest, journal: memoryJournal() })
	const [ticket, ...none] = await client.exitTickets({ payee })
	expect(none, "one ticket to the payee").toEqual([])
	expect(ticket).toMatchObject({ kind: "ragequit", payee, amount, label: note.label })
	if (!ticket) throw new Error("no ticket")

	await dialog.getByRole("button", { name: "Close" }).click()
	await page.getByRole("button", { name: "Exits" }).click()
	const deployment = `${s.manifest.chainId}:${s.manifest.bridge.portal}:${s.manifest.bridge.hub}`.toLowerCase()
	const row = page.locator(`[data-testid="exit-row"][data-key="${deployment}:${ticket.l2TxHash}:${ticket.messageIndexInTx}"]`)
	await expect(row).toHaveAttribute("data-status", "ready", { timeout: WAIT.ready })
	step("ticket ready")
	await l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	await row.getByRole("button", { name: "Collect on Ethereum" }).click()
	await expect(row).toHaveAttribute("data-status", "settled", { timeout: WAIT.settled })
	step("collected")

	expect(await client.exitStatus(ticket)).toBe("settled")
	const reads = createPublicClient({ transport: http(s.manifest.l1Rpc) })
	const paid = await reads.readContract({ address: s.manifest.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [payee] })
	expect(paid, "the payee holds exactly the exit").toBe(amount)
	await watch.clean()
})
