import { PoolClientError, spendRevertCode } from "@pp/pool-client"
import { type Account, type Chain, type Hash, hexToBigInt, isAddressEqual, type PublicClient, type WalletClient } from "viem"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { sendGasLimit } from "../l1-gas"
import { type Intent, latestMined, observe, planAttempt } from "./attempts"
import { contractRevert, guarded, unsentError } from "./boundary"
import { assertBridgeSpend, snapshotSpend } from "./checks"
import { BridgeClientError, type StaleRootCode } from "./errors"
import { Journal, type JournalRecord, type KeyValueStore } from "./journal"
import type { Preflights } from "./preflight"
import {
	type BridgeIntent,
	type Resolution,
	type ResolverClient,
	type ResolverDeployment,
	resolveNullifier,
	revertCause,
	revertData,
} from "./resolve"
import { type BridgeSession, type SessionSecrets, useSession } from "./session"
import type { BridgeReceipt, PreparedBridgeSpend } from "./types"

export type SubmitReader = ResolverClient & Pick<PublicClient, "simulateContract" | "estimateContractGas" | "waitForTransactionReceipt">

export type SubmitContext = {
	deployment: ResolverDeployment & { id: string }
	reader: SubmitReader
	store: KeyValueStore
	preflights: Preflights
	/** Proves the same note, amount and recipient again after a fresh sync (`prepareBridgeSpend`). */
	reprove: (s: BridgeSession, spend: PreparedBridgeSpend) => Promise<PreparedBridgeSpend>
	receiptTimeoutMs: number
}

export type SubmitOptions = { onReprove?: (code: StaleRootCode) => void; acceptUncertain?: boolean }

/** A third stale result is reported, not re-proved: roots that keep moving need the user. */
export const MAX_REPROOFS = 2

type Run = {
	ctx: SubmitContext
	l1: WalletClient
	account: Account
	chain: Chain | null
	session: BridgeSession
	secrets: SessionSecrets
	journal: Journal
	o: SubmitOptions
}

type SendPlan = { record: JournalRecord; previous: string | null }

const STALE_CODES: ReadonlySet<string> = new Set<StaleRootCode>(["STATE_ROOT_STALE", "KEYSTORE_ROOT_STALE", "ASP_ROOT_STALE"])

const staleCode = (e: unknown): StaleRootCode | null =>
	e instanceof PoolClientError && STALE_CODES.has(e.code) ? (e.code as StaleRootCode) : null

const contextOf = async (ctx: SubmitContext | (() => Promise<SubmitContext>)) => (typeof ctx === "function" ? ctx() : ctx)

// The proof's own nullifier, never the metadata field: checks have tied the two together by now.
const intentOf = (s: PreparedBridgeSpend): Intent => ({
	nullifier: s.proof.pubSignals[0]?.[0] as bigint,
	recipient: s.recipient.toString(),
	amount: s.amount,
})

/** A re-proof refreshes roots only: the same note, amount, recipient and claim, or nothing is sent. */
function sameSpend(was: PreparedBridgeSpend, now: PreparedBridgeSpend): PreparedBridgeSpend {
	const a = intentOf(was)
	const b = intentOf(now)
	const same =
		a.nullifier === b.nullifier &&
		a.amount === b.amount &&
		a.recipient === b.recipient &&
		was.spentCommitment === now.spentCommitment &&
		was.claimSalt === now.claimSalt &&
		was.secretHash.toLowerCase() === now.secretHash.toLowerCase()
	if (!same) throw new BridgeClientError("SPEND_MISMATCH", { check: "request" })
	return now
}

const bridgeIntentOf = (s: PreparedBridgeSpend): BridgeIntent => ({
	nullifier: s.proof.pubSignals[0]?.[0] as bigint,
	amount: s.amount,
	secretHash: hexToBigInt(s.secretHash),
})

/**
 * A receipt for a verified event, a throw for another spend or an inconsistent RPC, `null` while
 * nothing landed. `hash` is the user's own transaction, when this run sent one.
 */
function outcome(r: Resolution, hash?: Hash): BridgeReceipt | null {
	const own = hash ? { l1TxHash: hash } : {}
	if (r.kind === "bridged") return r.receipt
	if (r.kind === "elsewhere") throw new BridgeClientError("CONSUMED_ELSEWHERE", own)
	if (r.kind === "inconsistent") throw new BridgeClientError("RPC_INCONSISTENT", own)
	return null
}

const resolveFor = (run: Run, s: PreparedBridgeSpend, ownSucceeded: boolean, minHead?: bigint) =>
	resolveNullifier(run.ctx.reader, run.ctx.deployment, bridgeIntentOf(s), ownSucceeded, minHead)

const bridgeCall = (run: Run, s: PreparedBridgeSpend) => ({
	address: run.ctx.deployment.portal,
	abi: PROCESSOR_PORTAL_ABI,
	functionName: "bridgeFromPool" as const,
	args: [s.proof, s.noteData, s.secretHash] as const,
	account: run.account,
})

async function openRun(
	ctx: SubmitContext,
	l1: WalletClient,
	account: Account | undefined,
	chain: Chain | undefined,
	s: unknown,
	o: SubmitOptions,
	snap: PreparedBridgeSpend,
): Promise<Run> {
	const { session, secrets } = useSession(s, ctx.deployment.id)
	if (!account) throw new BridgeClientError("RPC_FAILED", { source: "AccountNotFoundError" })
	if ((await l1.getChainId()) !== ctx.deployment.chainId || (chain && chain.id !== ctx.deployment.chainId))
		throw new BridgeClientError("CHAIN_MISMATCH")
	if (isAddressEqual(account.address, session.l1Address)) throw new BridgeClientError("SENDER_IS_OWNER")
	ctx.preflights.require(ctx.deployment.id, snap.recipient)
	const journal = new Journal(ctx.store, secrets.journal, ctx.deployment.id)
	return { ctx, l1, account, chain: chain ?? null, session, secrets, journal, o }
}

/**
 * Whether a send may go out, judged over every earlier attempt: a verified event returns its receipt;
 * otherwise `planAttempt` decides. A record that no longer opens counts as an attempt that may land.
 */
async function journalGuard(run: Run, s: PreparedBridgeSpend): Promise<{ receipt: BridgeReceipt } | SendPlan> {
	const intent = intentOf(s)
	const accept = run.o.acceptUncertain === true
	const { raw, record } = await run.journal.read(intent.nullifier)
	if (raw === null) return { record: { ...intent, attempts: [{}] }, previous: null }
	const held: JournalRecord = record ?? { ...intent, attempts: [], evicted: true }
	const observed = await Promise.all(held.attempts.map((a) => observe(run.ctx.reader, a)))
	const mined = latestMined(observed)
	const resolution = await resolveFor(run, s, mined !== undefined, mined?.block).catch((e: unknown) => {
		if (mined) throw new BridgeClientError("UNCERTAIN", { l1TxHash: mined.hash })
		throw e
	})
	const receipt = outcome(resolution, mined?.hash)
	if (receipt) return { receipt }
	const plan = planAttempt(
		held,
		observed.map((x) => x.state),
		intent,
		accept,
	)
	if (plan.kind === "refuse") {
		const last = plan.hashes.at(-1)
		throw new BridgeClientError(plan.code, last ? { l1TxHash: last } : {})
	}
	return { record: plan.record, previous: raw }
}

type Fresh = { kind: "ready"; gas: bigint } | { kind: "stale"; stale: StaleRootCode } | { kind: "done"; receipt: BridgeReceipt }

/** The pool's root check, then the real call simulated from the sender; any other revert goes to the resolver. */
async function freshness(run: Run, s: PreparedBridgeSpend): Promise<Fresh> {
	try {
		await run.session.pool.assertFresh(s)
	} catch (e) {
		const stale = staleCode(e)
		if (stale) return { kind: "stale", stale }
		throw e
	}
	const call = bridgeCall(run, s)
	try {
		await run.ctx.reader.simulateContract(call)
		return { kind: "ready", gas: sendGasLimit(await run.ctx.reader.estimateContractGas(call)) }
	} catch (e) {
		const data = revertData(e)
		const stale = data ? spendRevertCode(data) : null
		if (stale) return { kind: "stale", stale }
		const reverted = contractRevert(e)
		if (data === undefined && !reverted) throw e
		const receipt = outcome(await resolveFor(run, s, false))
		if (receipt) return { kind: "done", receipt }
		throw new BridgeClientError("SIMULATION_REVERTED", reverted ?? {})
	}
}

/** The transaction may be out, so this never reports `RPC_FAILED`: a found event wins, anything else is `UNCERTAIN`. */
async function afterSendFailure(run: Run, s: PreparedBridgeSpend, hash?: Hash): Promise<BridgeReceipt> {
	const r = await resolveFor(run, s, false).catch(() => null)
	if (r?.kind === "bridged") return r.receipt
	throw new BridgeClientError("UNCERTAIN", hash ? { l1TxHash: hash } : {})
}

function withHash(r: JournalRecord, hash: Hash): JournalRecord {
	return { ...r, attempts: [...r.attempts.slice(0, -1), { l1TxHash: hash }] }
}

async function broadcast(run: Run, s: PreparedBridgeSpend, plan: SendPlan, gas: bigint): Promise<BridgeReceipt> {
	await run.ctx.preflights.consume(run.ctx.deployment.id, s.recipient)
	const written = await run.journal.write(plan.record)
	let hash: Hash
	try {
		hash = await run.l1.writeContract({ ...bridgeCall(run, s), chain: run.chain, gas })
	} catch (e) {
		const unsent = unsentError(e)
		if (!unsent) return afterSendFailure(run, s)
		await run.journal.restore(plan.record.nullifier, plan.previous, written)
		throw unsent
	}
	const saved = await run.journal.write(withHash(plan.record, hash)).then(
		() => true,
		() => false,
	)
	if (!saved) return afterSendFailure(run, s, hash)
	const receipt = await run.ctx.reader.waitForTransactionReceipt({ hash, timeout: run.ctx.receiptTimeoutMs }).catch(() => null)
	if (!receipt) return afterSendFailure(run, s, hash)
	// viem answers with a replacement's receipt when the wallet sped up or cancelled the send, and
	// only our own transaction's success implies a bridge event.
	const own = receipt.transactionHash === hash
	// From here a transaction is mined, so a failed read is UNCERTAIN with its hash, never RPC_FAILED.
	const resolved = await resolveFor(run, s, own && receipt.status === "success", receipt.blockNumber).catch(() => null)
	if (!resolved) return afterSendFailure(run, s, hash)
	const done = outcome(resolved, hash)
	if (done) return done
	if (!own) return afterSendFailure(run, s, hash)
	const stale = await revertCause(run.ctx.reader, hash, spendRevertCode).catch(() => null)
	throw new BridgeClientError("REVERTED", { stale, l1TxHash: hash })
}

/**
 * Sends a checked bridge spend and returns the receipt of the verified `BridgedFromPool` event for
 * its nullifier, whichever transaction carried it. Never resubmits by itself: a send whose outcome
 * is unknown ends `UNCERTAIN` and needs `acceptUncertain` to try again. A send refused before it
 * left restores the journal: the user's refusal is `RPC_FAILED` (`UserRejectedRequestError`), and a
 * wallet viem finds on another chain is `CHAIN_MISMATCH`. A second call for the same nullifier while
 * one runs in this process is `IN_FLIGHT`, whatever deployment, vault or store it names.
 *
 * Known limit: the journal is authenticated, not fresh, and kept per deployment. A record deleted or
 * rolled back in the store, a second process or tab over the same storage, or a later send of the
 * note through another generation's portal on the same vault, can let a note be sent again while an
 * earlier send is pending; the vault lets only one land, so the cost is a reverted transaction's gas.
 *
 * @param ctx a function is called only after the spend is snapshotted and its note held, so a context
 *   that needs IO (the client's one-time deployment check) keeps both guarantees.
 */
export function submit(
	ctx: SubmitContext | (() => Promise<SubmitContext>),
	spend: PreparedBridgeSpend,
	l1: WalletClient,
	s: BridgeSession,
	o: SubmitOptions = {},
): Promise<BridgeReceipt> {
	return guarded(async () => {
		// Taken before the first await, so nothing the caller does afterwards changes what is checked or sent.
		let snap = snapshotSpend(spend)
		const release = holdNote(snap)
		try {
			const { account, chain } = l1
			const run = await openRun(await contextOf(ctx), l1, account, chain, s, o, snap)
			for (let reproofs = 0; ; reproofs++) {
				await assertBridgeSpend(snap, run.session.pool, run.secrets.claimKey, run.ctx.deployment)
				const guard = await journalGuard(run, snap)
				if ("receipt" in guard) return guard.receipt
				const fresh = await freshness(run, snap)
				if (fresh.kind === "done") return fresh.receipt
				if (fresh.kind === "ready") return await broadcast(run, snap, guard, fresh.gas)
				if (reproofs === MAX_REPROOFS) throw new BridgeClientError("STALE", { stale: fresh.stale })
				o.onReprove?.(fresh.stale)
				snap = sameSpend(snap, snapshotSpend(await run.ctx.reprove(run.session, snap)))
			}
		} finally {
			release()
		}
	})
}

/**
 * Invariant: within one runtime, at most one `submit` at a time reaches a wallet for a given proof
 * nullifier. The key is the nullifier alone, the one value the proof itself commits to, so no
 * caller-supplied deployment, vault or store can split it; equal nullifiers on two chains or pools
 * only queue behind each other. Separate processes or tabs are not covered: the journal has no
 * compare-and-set and is per deployment, so both may send, and the vault lets one land.
 */
const running = new Set<bigint>()

/** @throws BridgeClientError `SPEND_MISMATCH` (`nullifier`) when the proof's first signal is missing or is not the spend's nullifier */
function holdNote(s: PreparedBridgeSpend): () => void {
	const key = s.proof.pubSignals[0]?.[0]
	if (key === undefined || key !== s.nullifier) throw new BridgeClientError("SPEND_MISMATCH", { check: "nullifier" })
	if (running.has(key)) throw new BridgeClientError("IN_FLIGHT")
	running.add(key)
	return () => running.delete(key)
}
