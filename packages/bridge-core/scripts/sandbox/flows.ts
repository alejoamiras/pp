/** The bridge round trips as pure functions of a context. Each returns the one-line evidence the
 *  smoke prints; each throws on the first assertion it cannot make. None keeps state between calls. */
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Address, parseAbi, toFunctionSelector } from "viem"
import { PORTAL_FACTORY_ABI, TOKEN_PORTAL_ABI } from "../../src/factory-abi"
import { consumeWithdrawal, isOutboxMessageConsumed } from "../../src/flows"
import { exitViaHub, type HubExitParams, hubExitsPaused, hubTokenFor, preflightHubExit } from "../../src/hub-l2"
import type { JournalTokenBlock } from "../../src/journal"
import type { ManifestToken } from "../../src/manifest-v2"
import { waitForL1ToL2Message } from "../generation"
import { ZERO_L1 } from "./constants"
import { balanceOf, claim, claimOnce, deposit, depositFresh, registerArgsOf, settled, type SmokeContext, tokenBlockOf } from "./context"
import { erc20BalanceOf, freshToken, mint, writeL1 } from "./l1"
import { withBlockHeartbeat } from "./l2"

// ─── Deposits ────────────────────────────────────────────────────────────────

export async function flowPublicDeposit(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = 100n * 10n ** BigInt(token.decimals)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const before = await balanceOf(l2Token, s.l2.from, "public")
	const res = await deposit(s, { erc20: token.erc20 as Address, amount, recipient: s.l2.from, isPrivate: false })
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from })
	const gained = (await balanceOf(l2Token, s.l2.from, "public")) - before
	if (gained < amount) throw new Error(`public balance rose by ${gained}, expected ${amount}`)
	if (outcome.path !== "claim") throw new Error(`expected the plain claim path for a registered token, got ${outcome.path}`)
	return `${outcome.path}, +${gained} ${token.displaySymbol}`
}

export async function flowPrivateDeposit(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = 50n * 10n ** BigInt(token.decimals)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const before = await balanceOf(l2Token, s.l2.from, "private")
	const res = await deposit(s, { erc20: token.erc20 as Address, amount, recipient: s.l2.from, isPrivate: true })
	const outcome = await claim(s, res, { amount, isPrivate: true, recipient: s.l2.from })
	const gained = (await balanceOf(l2Token, s.l2.from, "private")) - before
	if (gained < amount) throw new Error(`private balance rose by ${gained}, expected ${amount}`)
	return `${outcome.path}, +${gained} ${token.displaySymbol} privately`
}

/** The witness lookup's wording when no message carries the claimed secret hash. */
const NO_SUCH_MESSAGE = /no l1 to l2 message found/i

export async function flowRelayedPrivateDeposit(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = 25n * 10n ** BigInt(token.decimals)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const res = await deposit(s, { erc20: token.erc20 as Address, amount, recipient: s.l2.from, isPrivate: true })
	await waitForL1ToL2Message(s.l2.node, res.messageHashHex, { forceBlock: s.l2.forceBlock })
	// The consumption secret is derived from (salt, recipient) in-circuit, so naming the relayer as
	// the recipient derives a secret whose message the Inbox never carried.
	let refusal = ""
	try {
		await claimOnce(s, res, { amount, isPrivate: true, recipient: s.relayer, submitter: "relayer" })
	} catch (e) {
		refusal = e instanceof Error ? e.message : String(e)
	}
	if (!refusal) throw new Error("SECURITY: a relayer redirected a private claim to itself")
	if (!NO_SUCH_MESSAGE.test(refusal)) throw new Error(`the redirected claim failed for another reason: ${refusal.slice(0, 200)}`)

	const before = await balanceOf(l2Token, s.l2.from, "private")
	const outcome = await claim(s, res, { amount, isPrivate: true, recipient: s.l2.from, submitter: "relayer" })
	const gained = (await balanceOf(l2Token, s.l2.from, "private")) - before
	if (gained < amount) throw new Error(`relayed claim credited ${gained}, expected ${amount}`)
	return `wrong recipient rejected (no message for its secret), then ${outcome.path} submitted by the relayer credited the actor`
}

// ─── Exits ───────────────────────────────────────────────────────────────────

export interface ExitPlan {
	token: ManifestToken
	l2Token: ContractBase
	amount: bigint
	isPrivate: boolean
}

type ExitReceipt = { txHash: unknown }

/** The burn's authwit, then the exit the way the app sends it: a public exit runs the preflight
 *  (pause assert, portal read, burn) before it is sent; a private one carries its witness. Both ride
 *  the sponsor. PROPOSED when this returns. */
async function sendExit(s: SmokeContext, p: ExitPlan): Promise<ExitReceipt> {
	const authwitNonce = Fr.random()
	const exit: HubExitParams = {
		l2Token: p.token.l2Token,
		recipientL1: s.l1.account.address,
		amount: p.amount,
		callerOnL1: ZERO_L1,
		authwitNonce,
		isPrivate: p.isPrivate,
	}
	const burn = p.isPrivate
		? p.l2Token.methods.burn_private(s.l2.from, p.amount, authwitNonce)
		: p.l2Token.methods.burn_public(s.l2.from, p.amount, authwitNonce)
	const intent = { caller: s.hub.address, action: burn }
	const from = s.l2.from.toString()
	if (p.isPrivate) {
		const authWitnesses = [await s.l2.wallet.createAuthWit(s.l2.from, intent as never)]
		const { receipt } = (await exitViaHub(s.hub, exit, { ...s.l2.sendOpts, authWitnesses })) as unknown as { receipt: ExitReceipt }
		return receipt
	}
	const authwit = await SetPublicAuthwitContractInteraction.create(s.l2.wallet as never, s.l2.from, intent as never, true)
	await authwit.send(s.l2.sendOpts as never)
	await preflightHubExit(s.hub, exit, from)
	const { receipt } = (await exitViaHub(s.hub, exit, s.l2.sendOpts)) as unknown as { receipt: ExitReceipt }
	return receipt
}

/** Prove, witness, consume — and return what L1 released. */
async function finishExit(s: SmokeContext, token: ManifestToken, receipt: ExitReceipt, amount: bigint): Promise<bigint> {
	const before = await erc20BalanceOf(s.l1, token.erc20 as Address, s.l1.account.address)
	// The burn's epoch cannot prove while the chain is idle, and the Outbox refuses the consume until
	// it has — so the heartbeat runs for the whole finalization, not just the message wait.
	await withBlockHeartbeat(s.l2, () =>
		consumeWithdrawal(
			s.l1,
			s.l2.node as never,
			receipt,
			{
				recipientL1: s.l1.account.address,
				amount,
				portal: token.portal as Address,
				portalAbi: TOKEN_PORTAL_ABI as never,
				provenTimeoutSec: 900,
			},
			(stage) => console.log(`    withdraw: ${stage} (${s.mins()})`),
		),
	)
	const released = (await erc20BalanceOf(s.l1, token.erc20 as Address, s.l1.account.address)) - before
	if (released < amount) throw new Error(`L1 released ${released}, expected ${amount}`)
	return released
}

export async function runExit(s: SmokeContext, p: ExitPlan): Promise<string> {
	const kind = p.isPrivate ? "private" : "public"
	const before = await balanceOf(p.l2Token, s.l2.from, kind)
	const receipt = await sendExit(s, p)
	const after = await settled(
		() => balanceOf(p.l2Token, s.l2.from, kind),
		(v) => before - v >= p.amount,
		`the ${kind} balance after the burn`,
	)
	if (before - after !== p.amount) throw new Error(`the ${kind} exit burned ${before - after}, expected ${p.amount}`)
	const released = await finishExit(s, p.token, receipt, p.amount)
	return `${kind} burn → Outbox consume released ${released} ${p.token.displaySymbol}-units on L1`
}

/** The Outbox answers "not consumed" while the exit is only proposed, and "consumed" once the
 *  finalized consume has run — the two reads a resumable exit decides from. */
export async function flowOutboxRoundTrip(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = 10n ** BigInt(token.decimals)
	const receipt = await sendExit(s, { token, l2Token, amount, isPrivate: false })
	if (await isOutboxMessageConsumed(s.l1, s.l2.node as never, receipt)) throw new Error("a just-proposed exit read as already consumed")
	const status = String((await s.l2.node.getTxReceipt(receipt.txHash as never)).status ?? "")
	const released = await finishExit(s, token, receipt, amount)
	if (!(await isOutboxMessageConsumed(s.l1, s.l2.node as never, receipt))) throw new Error("a consumed exit still reads as not consumed")
	return `exit ${status} at the first read, not consumed; after finalization the consume released ${released} and reads as consumed`
}

// ─── First-time token shapes ─────────────────────────────────────────────────

export async function flowRelayerFirstRegister(s: SmokeContext): Promise<string> {
	const amount = 10n ** 18n
	const erc20 = await freshToken(s.l1, { name: "Relayer First", symbol: "RLY", decimals: 18 }, [s.l1.account.address], amount)
	const res = await depositFresh(s, erc20, amount)
	const block = res.token
	const l2Token = await s.l2TokenOf(block)
	await waitForL1ToL2Message(s.l2.node, block.registerKey as string, { forceBlock: s.l2.forceBlock })
	// The relayer consumes the factory's register leaf; the depositor's claim then has nothing left to
	// register and must succeed as a plain claim.
	await s.hub.methods.register_token(...registerArgsOf(block, block.nameWord)).send(s.relayerOpts as never)
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from })
	if (outcome.path !== "claim") throw new Error(`expected a plain claim after a relayer registration, got ${outcome.path}`)
	const balance = await balanceOf(l2Token, s.l2.from, "public")
	if (balance < amount) throw new Error(`balance ${balance} < ${amount}`)
	return `the relayer registered RLY first, the depositor's ${outcome.path} landed ${balance}`
}

export async function flowConcurrentFirstClaims(s: SmokeContext): Promise<string> {
	const amount = 10n ** 18n
	const erc20 = await freshToken(
		s.l1,
		{ name: "Race Token", symbol: "RACE", decimals: 18 },
		[s.l1.account.address, s.l1b.account.address],
		amount,
	)
	const first = await depositFresh(s, erc20, amount)
	const second = await depositFresh(s, erc20, amount, s.l1b)
	await waitForL1ToL2Message(s.l2.node, second.messageHashHex, { forceBlock: s.l2.forceBlock })

	const settled = await Promise.allSettled([
		claim(s, first, { amount, isPrivate: false, recipient: s.l2.from }),
		claim(s, second, { amount, isPrivate: false, recipient: s.relayer, submitter: "relayer" }),
	])
	const paths: string[] = []
	for (const [i, outcome] of settled.entries()) {
		if (outcome.status === "fulfilled") {
			paths.push(outcome.value.path)
			continue
		}
		// The loser of the register race retries as a plain claim once the winner's registration lands.
		const retry = await claim(s, i === 0 ? first : second, {
			amount,
			isPrivate: false,
			recipient: i === 0 ? s.l2.from : s.relayer,
			submitter: i === 0 ? undefined : "relayer",
		})
		paths.push(retry.path)
	}
	if (paths.filter((p) => p === "register+claim").length !== 1 || paths.filter((p) => p === "claim").length !== 1) {
		throw new Error(`expected one register+claim and one plain claim, got ${paths.join(" + ")}`)
	}
	return `two first-time deposits from two L1 accounts settled as ${paths.join(" + ")}`
}

export async function flowPortalOnlyToken(s: SmokeContext, pxo: ManifestToken): Promise<string> {
	const amount = 10n ** 18n
	if (await hubTokenFor(s.hub, pxo.erc20, s.l2.from.toString()))
		throw new Error("PXO was already registered — the fixture is not portal-only")
	await mint(s.l1, pxo.erc20 as Address, s.l1.account.address, amount)
	const res = await depositFresh(s, pxo.erc20 as Address, amount)
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from })
	if (outcome.path !== "register+claim") throw new Error(`expected register+claim for a portal-only token, got ${outcome.path}`)
	const l2Token = await s.l2TokenOf(res.token)
	const balance = await balanceOf(l2Token, s.l2.from, "public")
	if (balance < amount) throw new Error(`balance ${balance} < ${amount}`)
	return `portal existed, hub did not know it; the claim took ${outcome.path}`
}

// ─── Rejected registration ───────────────────────────────────────────────────

/** A tampered word hashes to a message the Inbox never carried, so the consume finds no witness —
 *  and because the consume runs FIRST, the register leaf survives for the corrected attempt. */
async function rejectTamperedRegistration(s: SmokeContext, block: JournalTokenBlock): Promise<string> {
	const tampered = `0x00${"ff".repeat(31)}`
	try {
		await s.hub.methods.register_token(...registerArgsOf(block, tampered)).send(s.l2.sendOpts as never)
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e)
		// Only the missing witness counts as the rejection; a wallet, fee or RPC failure is not it.
		if (!NO_SUCH_MESSAGE.test(message)) throw new Error(`the tampered registration failed for another reason: ${message}`)
		return message
	}
	throw new Error("a registration with tampered metadata was accepted")
}

export async function flowRejectedRegistration(s: SmokeContext): Promise<string> {
	const amount = 100n * 10n ** 6n
	const erc20 = await freshToken(s.l1, { name: "Bad Register", symbol: "BADS", decimals: 6 }, [s.l1.account.address], amount)
	const res = await depositFresh(s, erc20, amount)
	await waitForL1ToL2Message(s.l2.node, res.token.registerKey as string, { forceBlock: s.l2.forceBlock })
	const rejection = await rejectTamperedRegistration(s, res.token)
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from })
	if (outcome.path !== "register+claim") throw new Error(`expected register+claim after the rejected attempt, got ${outcome.path}`)
	const balance = await balanceOf(await s.l2TokenOf(res.token), s.l2.from, "public")
	if (balance < amount) throw new Error(`balance ${balance} < ${amount}`)
	return `tampered register rejected ("${rejection.slice(0, 70)}"), corrected ${outcome.path} landed ${balance}`
}

// ─── Pause switches ──────────────────────────────────────────────────────────

/** Pauses, proves the refusal, proves a claim still lands, and ALWAYS unpauses — a paused hub left
 *  behind would fail every later exit for reasons unrelated to them. */
export async function flowGuardianPause(s: SmokeContext, token: ManifestToken): Promise<string> {
	const exit = {
		l2Token: token.l2Token,
		recipientL1: s.l1.account.address,
		amount: 1n,
		callerOnL1: ZERO_L1,
		authwitNonce: Fr.random(),
		isPrivate: false,
	}
	await s.hub.methods.set_exits_paused(true).send(s.guardianOpts as never)
	let claimed: string
	try {
		if (!(await hubExitsPaused(s.hub, s.l2.from.toString()))) throw new Error("exits_paused() stayed false after the pause")
		let refusal = ""
		try {
			await preflightHubExit(s.hub, exit, s.l2.from.toString())
		} catch (e) {
			refusal = e instanceof Error ? e.message : String(e)
		}
		if (!/exits paused/i.test(refusal))
			throw new Error(`a paused exit preflight failed with "${refusal.slice(0, 120)}" instead of "exits paused"`)
		// Claims are deliberately NOT pausable: a deposit already made must always be claimable.
		claimed = await flowPublicDeposit(s, token, await s.l2TokenOf(tokenBlockOf(token)))
	} finally {
		await s.hub.methods.set_exits_paused(false).send(s.guardianOpts as never)
	}
	if (await hubExitsPaused(s.hub, s.l2.from.toString())) throw new Error("exits_paused() stayed true after the unpause")
	return `exit preflight refused with "exits paused" while a claim still landed (${claimed}); unpaused`
}

const PAUSED_ERRORS = {
	deposits: { name: "DepositsPaused", selector: toFunctionSelector("DepositsPaused()") },
	withdraws: { name: "WithdrawsPaused", selector: toFunctionSelector("WithdrawsPaused()") },
}
/** The owner's switch is not part of the app-facing factory ABI (the app only reads the flags). */
const SET_PAUSED_ABI = parseAbi(["function setPaused(bool deposits, bool withdraws)"])

/** Whether a portal call reverts with the named pause error — by name where the ABI decodes it,
 *  by selector otherwise. */
async function portalRefuses(
	s: SmokeContext,
	portal: Address,
	fn: "depositToAztecPublic" | "withdraw",
	args: unknown[],
): Promise<string | null> {
	try {
		await s.l1.pub.simulateContract({
			address: portal,
			abi: TOKEN_PORTAL_ABI as never,
			functionName: fn,
			args: args as never,
			account: s.l1.account,
		})
		return null
	} catch (e) {
		return e instanceof Error ? e.message : String(e)
	}
}

const refusesWith = (refusal: string | null, which: keyof typeof PAUSED_ERRORS) =>
	refusal !== null && (refusal.includes(PAUSED_ERRORS[which].name) || refusal.includes(PAUSED_ERRORS[which].selector))

/** What the Outbox answers a witness it never carried with (`Epoch` is a uint256 in the ABI). */
const OUTBOX_ERRORS = [
	"Outbox__NothingToConsumeAtEpoch(uint256)",
	"Outbox__NothingToConsume(bytes32)",
	"Outbox__InvalidRecipient(address,address)",
	"Outbox__LeafIndexOutOfBounds(uint256,uint256)",
	"Outbox__PathTooLong()",
	"Outbox__AlreadyNullified(uint256,uint256)",
	"Outbox__InvalidChainId()",
	"Outbox__VersionMismatch(uint256,uint256)",
	"Outbox__InvalidNumCheckpointsInEpoch(uint256)",
].map((signature) => ({ name: signature.slice(0, signature.indexOf("(")), selector: toFunctionSelector(signature) }))
const outboxErrorIn = (refusal: string | null): string | null =>
	refusal === null ? null : (OUTBOX_ERRORS.find((e) => refusal.includes(e.name) || refusal.includes(e.selector))?.name ?? null)

async function readPaused(s: SmokeContext): Promise<{ deposits: boolean; withdraws: boolean }> {
	const factory = s.bridge.l1.factory as Address
	const read = (functionName: "depositsPaused" | "withdrawsPaused") =>
		s.l1.pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI as never, functionName }) as Promise<boolean>
	return { deposits: await read("depositsPaused"), withdraws: await read("withdrawsPaused") }
}

/** The L1 switches: the factory's owner (the deployer) pauses deposits and withdraws, every portal
 *  refuses each before touching anything, and the switches are ALWAYS flipped back. The refusal is
 *  the portal's FIRST check, so a withdraw with no witness at all proves the pause rather than the
 *  Outbox; unpaused, the same call fails on its witness instead. */
export async function flowL1Pause(s: SmokeContext, token: ManifestToken): Promise<string> {
	const factory = s.bridge.l1.factory as Address
	const portal = token.portal as Address
	const deposit = [s.l2.from.toString(), 1n, `0x${"00".repeat(32)}`]
	const withdraw = [s.l1.account.address, 1n, false, 0n, 0n, 0n, []]
	await writeL1(s.l1, factory, SET_PAUSED_ABI, "setPaused", [true, true])
	try {
		const paused = await readPaused(s)
		if (!paused.deposits || !paused.withdraws) throw new Error(`setPaused(true, true) read back as ${JSON.stringify(paused)}`)
		const depositRefusal = await portalRefuses(s, portal, "depositToAztecPublic", deposit)
		if (!refusesWith(depositRefusal, "deposits"))
			throw new Error(`a paused deposit was refused with "${depositRefusal?.slice(0, 120)}", not DepositsPaused`)
		const withdrawRefusal = await portalRefuses(s, portal, "withdraw", withdraw)
		if (!refusesWith(withdrawRefusal, "withdraws"))
			throw new Error(`a paused withdraw was refused with "${withdrawRefusal?.slice(0, 120)}", not WithdrawsPaused`)
	} finally {
		await writeL1(s.l1, factory, SET_PAUSED_ABI, "setPaused", [false, false])
	}
	const after = await readPaused(s)
	if (after.deposits || after.withdraws) throw new Error(`setPaused(false, false) read back as ${JSON.stringify(after)}`)
	// Unpaused, the same bogus witness must reach the Outbox and be refused THERE — a null (accepted)
	// or an unrelated failure would let this pass on nothing.
	const witnessRefusal = await portalRefuses(s, portal, "withdraw", withdraw)
	const outboxError = outboxErrorIn(witnessRefusal)
	if (outboxError === null) {
		const what = witnessRefusal === null ? "accepted" : `refused with "${witnessRefusal.slice(0, 120)}"`
		throw new Error(`unpaused, the bogus witness was ${what} — not an Outbox refusal`)
	}
	return `factory paused both ways: the portal refused a deposit (DepositsPaused) and a withdraw (WithdrawsPaused) first; unpaused, the Outbox refused the witness (${outboxError})`
}
