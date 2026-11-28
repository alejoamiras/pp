/**
 * The canary's run: a fresh Aztec account bridges the owner's approved note, deploys and claims in one
 * sponsored transaction, makes checked private spends of its pool label and of a shielded birth label,
 * ragequits the whole balance to the owner and settles every burn on Ethereum.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/stdlib/tx"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { account, device, type ProvenTx } from "@pp/bridge-core/account"
import {
	BridgeClientError,
	type BridgeReceipt,
	type BridgeSession,
	openBridgeSession,
	PORTAL_FACTORY_ABI,
	prepareBridgeSpend,
	ragequitChunks,
} from "@pp/bridge-core"
import { secretDerivationTypedData } from "@pp/pool-client"
import { circuitsDir } from "@pp/pool-client/testing"
import { erc20Abi, type Hex, isAddressEqual } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { activePath, type BlockRef } from "../checked-transfer"
import { report } from "../cli/common"
import { generateKey } from "../keyfile"
import { toStackManifest } from "../manifest"
import { remember } from "../redact"
import { CanaryError } from "../report"
import { tokenView } from "../token"
import type { CanaryContext } from "./context"
import { type Holder, landed, PROVING_BUDGET_SEC, proveAndLand, sendProven, spendLabel, until } from "./l2"
import { burnTickets, epochThenSettle } from "./settle"

/** Shields move this many base units when the file sets no `amounts.shield`. */
export const DEFAULT_SHIELD = 1n
const CLAIMABLE_BUDGET_MS = 10 * 60_000
const BIRTH_ROOT_BUDGET_MS = 30 * 60_000
const BIRTH_ROOT_POLL_MS = 15_000
const FINALITY_BUDGET_MS = 40 * 60_000
const FINALITY_POLL_MS = 12_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nameOf = (e: unknown) => (e instanceof Error ? e.name : "Error")

/** The bot's first post, which must be checkpointed and successful, as the block that holds it. */
export async function resolvePost(c: Pick<CanaryContext, "node" | "postHash">): Promise<BlockRef> {
	const receipt = await c.node.getTxReceipt(TxHash.fromString(c.postHash))
	const block = receipt.blockNumber
	if (!["checkpointed", "proven", "finalized"].includes(receipt.status) || receipt.executionResult !== "success" || block === undefined)
		throw new CanaryError("FAILED", "POST_NOT_CHECKPOINTED", `--post ${c.postHash} is ${receipt.status}`)
	const data = await c.node.getBlockData(block)
	if (!data) throw new CanaryError("FAILED", "RPC_EVIDENCE_MISSING", `the node serves no block ${block} for --post`)
	// A block at the receipt's height that is not the receipt's own block means --post was reorged out.
	if (receipt.blockHash && data.blockHash.toString() !== receipt.blockHash.toString())
		throw new CanaryError("FAILED", "POST_REORGED", `--post ${c.postHash}'s block ${block} is no longer the one at that height`)
	return { block: Number(block), blockHash: data.blockHash.toString() as Hex }
}

/** The owner's bridge session, under the file's circuit bundle. The signature is never printed. */
async function openSession(c: CanaryContext): Promise<BridgeSession> {
	const signature = await privateKeyToAccount(c.ownerKey).signTypedData(secretDerivationTypedData(c.payee))
	remember([signature])
	return openBridgeSession({
		manifest: toStackManifest(c.d),
		l1Address: c.payee,
		signature,
		artifacts: { kind: "dir", path: circuitsDir(), bundle: c.d.bundle },
	})
}

/** The owner's first approved note of at least the bridge amount whose label is ACTIVE at a record of `--min-sequence` or later. */
async function approvedNote(c: CanaryContext, s: BridgeSession) {
	const { bridge } = c.d.expected.amounts
	for (const n of await s.pool.notes()) {
		if (n.status !== "approved" || n.value < bridge || !isAddressEqual(n.asset, c.d.pool.asset)) continue
		const active = await activePath(c.spendIo, n.label, 0, PROVING_BUDGET_SEC)
		if (active && active.record.sequence >= c.minSequence) return n
	}
	throw new CanaryError(
		"FAILED",
		"LABEL_NOT_ACTIVE",
		`no approved note of ${bridge} or more is ACTIVE at sequence ${c.minSequence} or later`,
	)
}

/** Step 1. Every attach check already ran in the guards; entries must be open and the bot's post checkpointed. */
async function attach(c: CanaryContext) {
	const paused = await c.l1.readContract({ address: c.d.bridge.factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })
	if (paused) throw new CanaryError("FAILED", "ENTRIES_PAUSED", "entries are paused: `open` runs before the canary")
	const post = await resolvePost(c)
	const session = await openSession(c)
	const note = await approvedNote(c, session)
	report("attached", { postBlock: post.block, label: note.label, sequenceAtLeast: c.minSequence })
	return { post, session, note }
}

/**
 * Step 2. A fresh account whose secret comes from the OS's CSPRNG and lives only in this process and
 * its tmpfs wallet store: losing the process before the settle strands the bridged amount.
 */
async function freshHolder(c: CanaryContext): Promise<Holder> {
	const secret = generateKey("l2")
	remember([secret])
	const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.fromHexString(secret))
	remember([signingKey.toString(), secretKey.toString()])
	const d = await device({ aztecNode: c.d.network.aztecNode, bridge: c.d.bridge }, { proverEnabled: true, sandboxKeysOnly: false })
	try {
		const a = await account(d, secret)
		report("account", { address: a.address.toString() })
		return { device: d, account: a, token: tokenView(d.wallet, d.token, a.address) }
	} catch (e) {
		await d.stop()
		throw e
	}
}

/** Watches the bridge's L1 block until the `finalized` tag covers it, in the background; returns its stop. */
function trackFinality(c: CanaryContext, block: bigint, blockTime: bigint): () => void {
	const stop = new AbortController()
	void (async () => {
		const end = Date.now() + FINALITY_BUDGET_MS
		while (!stop.signal.aborted && Date.now() < end) {
			const finalized = await c.l1.getBlock({ blockTag: "finalized" })
			if (finalized.number >= block) return c.report.wait("bridgeFinality", Date.now() - Number(blockTime) * 1000)
			await sleep(FINALITY_POLL_MS)
		}
	})().catch((e: unknown) => c.log(`bridge finality not observed: ${nameOf(e)}`))
	return () => stop.abort()
}

/** Step 3. Bridges `amounts.bridge` of the note to the holder from the sender, never the owner. */
async function bridge(c: CanaryContext, h: Holder, s: BridgeSession, note: { commitment: bigint }) {
	await c.client.preflight({ recipient: h.account.address, wallet: h.device.wallet })
	const spend = await prepareBridgeSpend(s, {
		note: note.commitment,
		amount: c.d.expected.amounts.bridge,
		portal: c.d.bridge.portal,
		recipient: h.account.address,
	})
	const receipt = await c.client.submit(spend, c.sender, s).catch((e: unknown) => {
		// An UNCERTAIN end that knows its hash names a transaction that may still land.
		if (e instanceof BridgeClientError && e.l1TxHash) {
			c.report.set("bridgeL1Tx", e.l1TxHash)
			c.report.flush()
		}
		throw e
	})
	// On file before any further read: a failure from here on strands the amount, and the hash names it.
	c.report.set("bridgeL1Tx", receipt.l1TxHash)
	c.report.flush()
	report("bridge-sent", { l1TxHash: receipt.l1TxHash, holder: h.account.address.toString() })
	const mined = await c.l1.waitForTransactionReceipt({ hash: receipt.l1TxHash })
	const { timestamp } = await c.l1.getBlock({ blockNumber: mined.blockNumber })
	c.report.set("bridgeL1Block", mined.blockNumber)
	report("bridged", { l1TxHash: receipt.l1TxHash, l1Block: mined.blockNumber, amount: receipt.amount })
	return { receipt, stopFinality: trackFinality(c, mined.blockNumber, timestamp) }
}

/** Step 4. */
async function claimable(c: CanaryContext, r: BridgeReceipt): Promise<void> {
	const t0 = performance.now()
	await c.client.waitClaimable(r, { signal: AbortSignal.timeout(CLAIMABLE_BUDGET_MS) })
	c.report.wait("claimable", performance.now() - t0)
}

/** The fallback once the one transaction failed definitively: the deploy, then the claim from the deployed account. */
async function claimApart(c: CanaryContext, h: Holder, payload: Awaited<ReturnType<CanaryContext["client"]["claimPayload"]>>) {
	await h.account.deploy()
	await proveAndLand(c, h, "claim", payload)
}

/**
 * Step 5. Deploy and claim in one sponsored transaction. Only a failure before the broadcast or a
 * checkpointed revert splits it; any other open outcome sends nothing more.
 * @throws CanaryError `I10_UNRESOLVED`
 */
async function deployAndClaim(c: CanaryContext, h: Holder, s: BridgeSession, r: BridgeReceipt): Promise<void> {
	const payload = await c.client.claimPayload(s, r)
	const t0 = performance.now()
	let proven: ProvenTx
	try {
		proven = await h.account.proveDeployAndClaim(payload)
	} catch (e) {
		c.report.set("oneTx", false)
		c.report.set("oneTxError", `PROVE_${nameOf(e)}`)
		c.log(`deploy and claim failed before its broadcast (${nameOf(e)}); deploying, then claiming`)
		return claimApart(c, h, payload)
	}
	const out = await sendProven(c, "deployClaim", proven, performance.now() - t0)
	c.report.set("oneTx", out.status === "checkpointed")
	if (out.status === "checkpointed") return
	if (out.status === "unresolved") {
		c.report.set("oneTxError", `UNRESOLVED_${out.reason.toUpperCase()}`)
		throw new CanaryError(
			"I10_UNRESOLVED",
			"I10_UNRESOLVED",
			`deploy and claim in L2 tx ${out.txHash} is ${out.reason}; nothing else is sent`,
		)
	}
	c.report.set("oneTxError", "REVERTED")
	c.log(`deploy and claim reverted in L2 tx ${out.txHash}; deploying, then claiming`)
	await claimApart(c, h, payload)
}

/** Step 7's birth: the holder's one birth-origin label, once its wallet has found the shielded note. */
async function bornLabel(h: Holder): Promise<bigint> {
	const rows = await until(
		() => h.token.labels(),
		(rs) => rs.some((r) => r.origin === 1 && r.balance > 0n),
		"NOTES_NOT_SYNCED",
		"the shielded note never showed in the wallet",
	)
	const born = [...new Set(rows.filter((r) => r.origin === 1 && r.balance > 0n).map((r) => r.label))]
	if (born.length !== 1) throw new CanaryError("FAILED", "BIRTH_LABELS", `the account holds ${born.length} birth labels`)
	return born[0] as bigint
}

/** Step 7's wait, logged as "waiting for the birth root": the bot's intake approved the birth and a record carries it. */
async function waitBirthRoot(c: CanaryContext, born: bigint): Promise<void> {
	c.log("waiting for the birth root")
	const t0 = performance.now()
	const end = Date.now() + BIRTH_ROOT_BUDGET_MS
	while (!(await activePath(c.spendIo, born, 1, PROVING_BUDGET_SEC))) {
		if (Date.now() >= end) throw new CanaryError("FAILED", "BIRTH_ROOT_TIMEOUT", "no record carried the birth within 30 min")
		await sleep(BIRTH_ROOT_POLL_MS)
	}
	c.report.wait("birthRoot", performance.now() - t0)
}

/** Steps 6 and 7: a checked self-transfer of the pool label; then unshield, shield, the birth root and a checked spend of the birth. */
async function checkedSpends(c: CanaryContext, h: Holder, poolLabel: bigint, post: BlockRef): Promise<void> {
	const self = h.account.address
	await c.report.step("selfTransfer", () =>
		spendLabel(c, h, "selfTransfer", { label: poolLabel, origin: 0, post }, (path) => h.token.transfer(self, 1n, poolLabel, path)),
	)
	const amount = c.d.expected.amounts.shield ?? DEFAULT_SHIELD
	await c.report.step("shield", async () => {
		await spendLabel(c, h, "unshield", { label: poolLabel, origin: 0, post }, (path) => h.token.unshield(amount, poolLabel, path))
		await proveAndLand(c, h, "shield", await h.token.shield(amount))
		const born = await bornLabel(h)
		await waitBirthRoot(c, born)
		await spendLabel(c, h, "birthTransfer", { label: born, origin: 1, post }, (path) => h.token.transfer(self, 1n, born, path))
	})
}

const total = (vs: readonly bigint[]) => vs.reduce((s, v) => s + v, 0n)

/** Burns `label`'s notes in exact chunks; each burn's hash enters the report before its broadcast. */
async function burnLabel(c: CanaryContext, h: Holder, label: bigint): Promise<void> {
	let notes = await h.token.values(label)
	while (notes.length) {
		const amount = ragequitChunks(notes)[0] as bigint
		const t0 = performance.now()
		const proven = await h.account.prove(await c.client.ragequitPayload({ payee: c.payee, amount, label }))
		const txHash = proven.txHash.toString() as Hex
		const burn: (typeof c.burns)[number] = { txHash, amount, label }
		c.burns.push(burn)
		c.report.push("burns", { txHash, amount })
		const out = await sendProven(c, "burn", proven, performance.now() - t0)
		landed(out, "burn")
		burn.block = out.receipt.blockNumber === undefined ? undefined : Number(out.receipt.blockNumber)
		const left = total(notes) - amount
		notes = await until(
			() => h.token.values(label),
			(vs) => total(vs) === left,
			"RPC_INCONSISTENT",
			`a landed burn of ${amount} never left the notes`,
		)
	}
}

/**
 * Step 8: once the wallet shows every note (its transfers to itself keep the bridged total), the
 * whole balance to the owner, label by label.
 */
async function ragequitAll(c: CanaryContext, h: Holder, bridged: bigint): Promise<void> {
	const rows = await until(
		() => h.token.labels(),
		(rs) => total(rs.map((r) => r.balance)) === bridged,
		"NOTES_NOT_SYNCED",
		`the wallet never showed the bridged ${bridged} in its notes`,
	)
	for (const label of new Set(rows.filter((r) => r.balance > 0n).map((r) => r.label))) await burnLabel(c, h, label)
}

const ownerBalance = (c: CanaryContext) =>
	c.l1.readContract({ address: c.d.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [c.payee] })

/** Steps 9 and 10, then the owner's balance delta against what the burns carried. */
async function exitAll(c: CanaryContext): Promise<void> {
	// Read before any ticket can be settled: none is until its epoch is proven.
	const before = await ownerBalance(c)
	await epochThenSettle(c, await burnTickets(c))
	const delta = (await ownerBalance(c)) - before
	const burned = total(c.burns.map((b) => b.amount ?? 0n))
	c.report.set("balanceDelta", delta)
	if (delta !== burned) throw new CanaryError("FAILED", "BALANCE_DELTA", `the owner received ${delta}, the burns carried ${burned}`)
}

/** Steps 1 to 10; step 11, the report, is the caller's on every outcome. */
export async function runCanary(c: CanaryContext): Promise<void> {
	const { post, session, note } = await c.report.step("attach", () => attach(c))
	const h = await c.report.step("account", () => freshHolder(c))
	let stopFinality = () => {}
	try {
		const bridged = await c.report.step("bridge", () => bridge(c, h, session, note))
		stopFinality = bridged.stopFinality
		await c.report.step("claimable", () => claimable(c, bridged.receipt))
		await c.report.step("deployClaim", () => deployAndClaim(c, h, session, bridged.receipt))
		await checkedSpends(c, h, note.label, post)
		await c.report.step("ragequit", () => ragequitAll(c, h, bridged.receipt.amount))
		await exitAll(c)
	} finally {
		stopFinality()
		await h.device.stop()
	}
}
