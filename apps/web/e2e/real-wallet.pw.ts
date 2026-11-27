/**
 * The pinned release of the real wallet, driven through its own windows behind the browser-level
 * fence (run with `bun run --cwd packages/e2e-kit test:real-wallet`). Serial, one account: each
 * test builds on the state the previous one left. Payer: anvil's seeded accounts on L1, the
 * SponsoredFPC on Aztec; the wallet's account never holds Fee Juice.
 */
import type { Page } from "@playwright/test"
import { createBridgeClient, type KeyValueStore } from "@pp/bridge-core"
import { anvilKey } from "@pp/bridge-core/sandbox"
import { EXECUTE_APPROVAL_MS } from "@pp/e2e-kit/real-wallet/driver.ts"
import { expect, type RealWallet, refusals, test } from "@pp/e2e-kit/real-wallet/fixture.ts"
import { createPublicClient, erc20Abi, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { formatAmount, plainAmount } from "../src/ui/format"
import { approvedNote, seededStack } from "./stack"
import { signInToPool } from "./support"

test.describe.configure({ mode: "serial" })

/** The bridge's L1 leg: proof in the page, then the spend mined and its message claimable. */
const CLAIMABLE_MS = 3 * 60_000
/** The wallet proves in WASM in its offscreen document; the claim also proves its account's constructor. */
const PROVED_MS = 12 * 60_000
/** The ragequit's L2→L1 message waits for its epoch's proof on the local stack. */
const READY_MS = 3 * 60_000
/** The app waits up to two minutes for the collect's receipt on the local chain, then refreshes. */
const SETTLED_MS = 150_000
const CRS_HOST = /^crs\.aztec/
/** The wallet's local Presto prover; refused, so it proves in WASM. */
const PRESTO_PORTS = [59833, 59834]
/** The token observation's wallet steps at their 60 s bounds, with a margin. */
const OBSERVE_MS = 5 * 60_000

/**
 * A test's cap: its waits in sequence, plus two minutes for the steps between them. Approval ends
 * before the proof's wait starts, so the two add.
 */
function capOf(...waits: number[]): number {
	return waits.reduce((sum, wait) => sum + wait, 2 * 60_000)
}

/** What `claims` left for `ragequits`: the serial tests share this worker. */
let claimed: { label: bigint; amount: bigint; init: bigint } | undefined

function sendSeq(rw: RealWallet, n: number): number {
	const seq = rw.node.calls().filter((c) => c.name === "sendTx")[n]?.seq
	if (seq === undefined) throw new Error(`the wallet made no send number ${n + 1}`)
	return seq
}

function memoryJournal(): KeyValueStore {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

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
	test.setTimeout(capOf(CLAIMABLE_MS, EXECUTE_APPROVAL_MS, PROVED_MS, OBSERVE_MS))
	const began = Date.now()
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
	await expect(screen).toHaveAttribute("data-step", "claimed", { timeout: PROVED_MS })
	rw.log(`claim approved to claimed in ${((Date.now() - start) / 1000).toFixed(1)} s`)

	const sent = rw.node.sentTxHashes()
	const sendSeq = rw.node.calls().find((c) => c.name === "sendTx")?.seq ?? Number.POSITIVE_INFINITY
	const queried = rw.node.nullifierQueries().filter((q) => q.answered !== undefined && q.answered < sendSeq)
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
	claimed = { label: note.label, amount, init: BigInt(initialized[0] ?? 0) }
	expect(
		refusals(rw).filter((r) => CRS_HOST.test(r.target)),
		"proving read the seeded points, not the CDN",
	).toEqual([])
	await rw.checkCache()
	expect(
		refusals(rw).some((r) => PRESTO_PORTS.some((p) => r.target === `127.0.0.1:${p}`)),
		"the wallet tried its local prover and reached only the recorder",
	).toBe(true)
	expect(
		rw.owned.filter((p) => PRESTO_PORTS.includes(p)),
		"no owned listener on the local prover's ports",
	).toEqual([])

	// Recorded, not asserted: what the wallet shows for the token is a finding, never a nightly failure,
	// so it runs only when its steps' bounds fit in the test's remaining time.
	const observe = () =>
		rw.driver
			.importToken(s.manifest.bridge.token)
			.then(async (imported) =>
				"added" in imported ? `${await rw.driver.tokenTotal(s.symbol)} ${s.symbol}` : `not imported: ${imported.refused}`,
			)
			.catch((e: Error) => `not observed: ${e.message.split("\n")[0]}`)
	const left = testInfo.timeout - (Date.now() - began)
	const total = testInfo.timeout === 0 || left > OBSERVE_MS ? await observe() : "not observed: too little of the test's time left"
	testInfo.annotations.push({ type: "wallet token total", description: `${total}; the app shows ${shown}` })
	rw.log(`wallet token total ${total}; the app shows ${shown}`)
})

// Fails if the wallet cannot prove or send the hub's ragequit from the app, if it initializes its
// account again, or if the ticket does not collect to the payee on Ethereum for exactly the claim.
test("ragequits", async ({ realWallet: rw, run }) => {
	test.setTimeout(capOf(EXECUTE_APPROVAL_MS, PROVED_MS, READY_MS, SETTLED_MS))
	if (!claimed) throw new Error("claims left no label to leave")
	const { label, amount, init } = claimed
	const page = rw.appPage
	const s = await seededStack(run)
	const payee = privateKeyToAccount(generatePrivateKey()).address
	expect(rw.node.sentTxHashes(), "the claim is the wallet's only send so far").toHaveLength(1)
	const begun = rw.node.calls().at(-1)?.seq ?? -1

	const row = page.locator(`[data-testid="label-row"][data-label="${label}"]`)
	await row.getByRole("button", { name: "Leave to Ethereum (ragequit)" }).click()
	const dialog = page.getByTestId("action-dialog")
	await dialog.getByRole("radio", { name: /Your largest note/ }).check()
	await dialog.getByLabel("Payee on Ethereum").fill(payee)
	await dialog.getByRole("button", { name: "Review" }).click()
	const start = Date.now()
	await rw.driver.approveExecute(() =>
		dialog
			.getByTestId("exit-review")
			.getByRole("button", { name: /^Leave to Ethereum/ })
			.click(),
	)
	await expect(dialog).toHaveAttribute("data-state", "done", { timeout: PROVED_MS })
	rw.log(`ragequit approved to sent in ${((Date.now() - start) / 1000).toFixed(1)} s`)

	const sent = rw.node.sentTxHashes()
	expect(sent, "the wallet sent exactly one more transaction").toHaveLength(2)
	const tx = await rw.chain.sentTx(sent[1] ?? "")
	const ragequitSeq = sendSeq(rw, 1)
	// The wallet's lookup counts only when made during this flow and answered before it sent.
	const initReads = rw.node
		.nullifierQueries()
		.filter((q) => q.seq > begun && q.answered !== undefined && q.answered < ragequitSeq && BigInt(q.value) === init)
	rw.log(`ragequit: ${JSON.stringify({ hash: tx.hash, succeeded: tx.succeeded, initReads })}`)
	expect(tx.succeeded, "the ragequit succeeded").toBe(true)
	expect(
		initReads.some((q) => q.found === true),
		"before the ragequit the wallet found its account's initialization nullifier",
	).toBe(true)
	expect(tx.nullifiers.map(BigInt), "the ragequit does not initialize the account again").not.toContain(init)

	const client = createBridgeClient({ manifest: s.manifest, journal: memoryJournal() })
	const [ticket, ...none] = await client.exitTickets({ payee })
	expect(none, "one ticket to the payee").toEqual([])
	expect(ticket).toMatchObject({ kind: "ragequit", payee, amount, label })
	if (!ticket) throw new Error("no ticket")
	expect(ticket.l2TxHash.toLowerCase(), "the ticket comes from the ragequit the wallet sent").toBe(tx.hash.toLowerCase())
	await dialog.getByRole("button", { name: "Close" }).click()
	await page.getByRole("button", { name: "Exits" }).click()
	const deployment = `${s.manifest.chainId}:${s.manifest.bridge.portal}:${s.manifest.bridge.hub}`.toLowerCase()
	const exit = page.locator(`[data-testid="exit-row"][data-key="${deployment}:${ticket.l2TxHash}:${ticket.messageIndexInTx}"]`)
	await expect(exit).toHaveAttribute("data-status", "ready", { timeout: READY_MS })
	await rw.l1.setAccount(anvilKey(s.stack.accounts.sender.index))
	const l1Sends = rw.l1.calls("eth_sendTransaction")
	await exit.getByRole("button", { name: "Collect on Ethereum" }).click()
	await page.getByTestId("collect-review").getByRole("button", { name: "Collect", exact: true }).click()
	await expect(exit).toHaveAttribute("data-status", "settled", { timeout: SETTLED_MS })
	const reads = createPublicClient({ transport: http(s.manifest.l1Rpc) })
	const paid = await reads.readContract({ address: s.manifest.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [payee] })
	expect(paid, "the payee holds exactly the claimed amount").toBe(amount)
	expect(rw.l1.calls("eth_sendTransaction") - l1Sends, "the collect went out once, from the injected wallet").toBe(1)
	expect(rw.node.sentTxHashes(), "the wallet sent nothing after the ragequit").toHaveLength(2)
	expect(
		rw.context.pages().filter((p) => p.url().includes("/src/popup/index.html#/windows/execute")),
		"no second execute window waits",
	).toEqual([])
})
