/**
 * The pinned release of the real wallet, driven through its own windows behind the browser-level
 * fence (run with `bun run --cwd packages/e2e-kit test:real-wallet`). Serial, one account: each
 * test builds on the state the previous one left. Payer: anvil's seeded accounts on L1, the
 * SponsoredFPC on Aztec; the wallet's account never holds Fee Juice.
 */
import type { Page } from "@playwright/test"
import { anvilKey } from "@pp/bridge-core/sandbox"
import { expect, refusals, test } from "@pp/e2e-kit/real-wallet/fixture.ts"
import { formatAmount, plainAmount } from "../src/ui/format"
import { approvedNote, seededStack } from "./stack"
import { signInToPool } from "./support"

test.describe.configure({ mode: "serial" })

/** The bridge's L1 leg: proof in the page, then the spend mined and its message claimable. */
const CLAIMABLE_MS = 3 * 60_000
/** The wallet proves the claim and its account's constructor in one transaction in its offscreen document. */
const CLAIMED_MS = 12 * 60_000
const CRS_HOST = /^crs\.aztec/
/** The wallet's local Presto prover; refused, so it proves in WASM. */
const PRESTO_PORTS = [59833, 59834]

/** The bridge form of `commitment`'s row with `amount` typed in. */
async function openForm(page: Page, commitment: bigint, amount: string) {
	await page.locator(`[data-testid="note-row"][data-commitment="${commitment}"]`).getByRole("button", { name: "Bridge to Aztec" }).click()
	const form = page.getByTestId("bridge-form")
	await form.getByLabel(/Amount to bridge/).fill(amount)
	return form
}

test("boot", async ({ realWallet: rw }) => {
	await rw.driver.onboard()
	const id = await rw.driver.addNetwork("pp-local", rw.node.url)
	expect(id, "the wallet chain id the stack's network gets").toBe(rw.expectedChainId)
	await expect
		.poll(() => rw.node.calls().some((c) => c.name === "getNodeInfo"), {
			message: "the wallet reaches the stack through the recording proxy",
			timeout: 60_000,
		})
		.toBe(true)
})

test("connects", async ({ realWallet: rw }) => {
	await rw.appPage.goto(`${rw.appOrigin}/`)
	const grid = await rw.driver.connect(rw.appPage)
	rw.log(`connected; both sides showed ${grid.join("")}`)
	await expect(rw.appPage.getByTestId("aztec-account")).toHaveCount(1)
	expect(await rw.appPage.evaluate(() => crossOriginIsolated), "the app stays cross-origin isolated with the wallet loaded").toBe(true)
})

// Fails if the wallet cannot prove or send the claim from the app, if the claim does not also
// initialize the wallet's account, if anyone but the SponsoredFPC pays, or if proving reached past the seeded points.
test("claims", async ({ realWallet: rw, run }, testInfo) => {
	const page = rw.appPage
	const s = await seededStack(run)
	const note = await approvedNote(s.pool)
	const amount = (note.value * 7n) / 10n
	const account = await page.getByTestId("aztec-account").getAttribute("data-address")
	if (!account) throw new Error("the app shows no connected account")
	expect(await rw.chain.sponsorFeeJuice(), "the SponsoredFPC holds Fee Juice").toBeGreaterThan(0n)
	expect(await rw.chain.feeJuice(account), "the wallet's account holds no Fee Juice").toBe(0n)
	expect(rw.node.sentTxHashes(), "the wallet has sent nothing yet").toEqual([])

	await rw.l1.setAccount(anvilKey(s.stack.accounts.user.index))
	await signInToPool(page)
	await rw.l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	const form = await openForm(page, note.commitment, plainAmount(amount, s.decimals))
	await form.getByRole("button", { name: "Bridge to Aztec" }).click()
	const screen = page.getByTestId("bridge-screen")
	await expect(screen).toHaveAttribute("data-step", "claimable", { timeout: CLAIMABLE_MS })
	const start = Date.now()
	await rw.driver.approveExecute(() => screen.getByRole("button", { name: "Claim on Aztec" }).click())
	await expect(screen).toHaveAttribute("data-step", "claimed", { timeout: CLAIMED_MS })
	rw.log(`claim approved to claimed in ${((Date.now() - start) / 1000).toFixed(1)} s`)

	const sent = rw.node.sentTxHashes()
	const sendSeq = rw.node.calls().find((c) => c.name === "sendTx")?.seq ?? Number.POSITIVE_INFINITY
	const queried = rw.node.nullifierQueries().filter((q) => q.seq < sendSeq)
	const methods = rw.node.calls().flatMap((c) => (c.seq < sendSeq ? [c.name] : []))
	rw.log(`before the send: ${JSON.stringify({ methods, queried })}`)
	expect(sent, "the wallet sent exactly one transaction").toHaveLength(1)
	const tx = await rw.chain.sentTx(sent[0] ?? "")
	const absent = new Set(queried.filter((q) => q.found === false).map((q) => BigInt(q.value)))
	const initialized = tx.nullifiers.filter((n) => absent.has(BigInt(n)))
	const sponsorship = await rw.chain.sponsorship(tx)
	rw.log(`claim: ${JSON.stringify({ tx, initialized, sponsorship }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`)
	expect(tx.succeeded, "the claim succeeded").toBe(true)
	expect(initialized, "exactly one nullifier the wallet found absent before the send is in the claim's effect").toHaveLength(1)
	expect(await rw.chain.hasWitness(initialized[0] ?? "0x0"), "the initialization nullifier is in the tree").toBe(true)
	expect(sponsorship.written, "the SponsoredFPC's balance dropped by exactly the fee").toBe(sponsorship.before - sponsorship.fee)
	expect(await rw.chain.feeJuice(account), "the wallet's account still holds no Fee Juice").toBe(0n)

	await screen.getByRole("button", { name: "Back to balances" }).last().click()
	const shown = formatAmount(amount, s.decimals, 2)
	await expect(page.locator(`[data-testid="label-row"][data-label="${note.label}"]`)).toContainText(shown, { timeout: 30_000 })
	expect(
		refusals(rw).filter((r) => CRS_HOST.test(r.target)),
		"proving read the seeded points, not the CDN",
	).toEqual([])
	await rw.checkCache()
	expect(
		rw.egress.hits().some((h) => PRESTO_PORTS.some((p) => h.target === `127.0.0.1:${p}`)),
		"the wallet tried its local prover and reached only the recorder",
	).toBe(true)
	expect(
		rw.owned.filter((p) => PRESTO_PORTS.includes(p)),
		"no owned listener on the local prover's ports",
	).toEqual([])

	// Recorded, not asserted: what the wallet shows for the token is a finding, never a nightly failure.
	const imported = await rw.driver.importToken(s.manifest.bridge.token)
	const total = "added" in imported ? `${await rw.driver.tokenTotal(s.symbol)} ${s.symbol}` : `not imported: ${imported.refused}`
	testInfo.annotations.push({ type: "wallet token total", description: `${total}; the app shows ${shown}` })
	rw.log(`wallet token total ${total}; the app shows ${shown}`)
})
