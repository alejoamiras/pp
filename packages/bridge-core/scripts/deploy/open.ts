/**
 * The R46 rule as one check both opening paths share, and the guardian's two writes. A pool spend
 * accepted while no hub can claim its message is stuck (a clone has no sweep), so entries open only
 * once every binding reads back as expectations fixed before the deploy, never as the chain reports
 * them. Node only.
 */
import { RegistryAbi } from "@aztec-foundation/l1-artifacts/RegistryAbi"
import { RollupAbi } from "@aztec-foundation/l1-artifacts/RollupAbi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import {
	type Account,
	type Address,
	type Chain,
	encodeFunctionData,
	getContractAddress,
	type Hash,
	type Hex,
	keccak256,
	type PublicClient,
	type TransactionReceipt,
	type WalletClient,
} from "viem"
import { tokenBridgeHubArtifact } from "../../src/artifacts"
import { aspRootRegistryArtifact } from "../../src/asp-registry-artifact"
import { type ClientTiming, clientTiming, LOCAL_TIMING } from "../../src/client/timing"
import { PORTAL_FACTORY_ABI } from "../../src/factory-abi"
import { assertGenerationBindings, rollupEndpointsOf } from "../../src/generation-bindings"
import { hubBindingAt } from "../../src/hub-l2"
import { artifactClassIds, deriveHub, NO_ASP_REGISTRY } from "../generation"
import { assertV1Hub } from "./v1-hub"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export type OpenL1 = Pick<PublicClient, "readContract" | "getBlock" | "getChainId">

/** The node reads the check makes; the full node client satisfies it. */
export interface OpenNode {
	getNodeInfo(): Promise<{
		l1ChainId: number
		rollupVersion: number
		l1ContractAddresses: {
			registryAddress: { toString(): string }
			rollupAddress: { toString(): string }
			inboxAddress: { toString(): string }
			outboxAddress: { toString(): string }
		}
	}>
	getContract(address: AztecAddress): Promise<{ currentContractClassId: { toString(): string } } | undefined>
	getContractClass(id: Fr): Promise<unknown>
	getPublicStorageAt(block: "latest", contract: AztecAddress, slot: Fr): Promise<Fr>
}

export type ExpectedRollup = { l1Registry: Address; rollup: Address; inbox: Address; outbox: Address; rollupVersion: bigint }
export type RegistryRoles = { admin: Hex; poster: Hex; birthIntake: Hex }
/** `l2Token` is the hub's labelled token for `asset`; the later-process open requires it on every portal. */
export type OpenPortal = { asset: Address; portal: Address; l2Token?: Hex }

export interface OpenContext {
	chainId: number
	l1: OpenL1
	node: OpenNode
	factory: Address
	portals: readonly OpenPortal[]
	hub: Hex
	/** The ASP registry the hub passes to its tokens, as an Aztec address hex. */
	registry: Hex
	expected: {
		guardian: Address
		lifetimeCap: bigint
		pool: Address
		rollup: ExpectedRollup
		registryRoles?: RegistryRoles
	}
}

export class OpenRefusedError extends Error {
	constructor(
		readonly check: string,
		detail: string,
	) {
		super(`refusing to open entries: ${check}: ${detail}`)
		this.name = "OpenRefusedError"
	}
}

function same(check: string, actual: unknown, want: unknown): void {
	if (String(actual).toLowerCase() !== String(want).toLowerCase()) throw new OpenRefusedError(check, `${actual}, expected ${want}`)
}

type Head = { number: bigint; hash: Hash }

/** EIP-1898: a backend answers at this header's hash or not at all, never with another branch's state at its height. */
const at = (head: Head) => ({ blockHash: head.hash, requireCanonical: true }) as const

async function latestHead(l1: OpenL1): Promise<Head> {
	const { number, hash } = await l1.getBlock({ blockTag: "latest" })
	return { number, hash }
}

async function checkCanonicalRollup(c: OpenContext, head: Head): Promise<void> {
	const r = c.expected.rollup
	same(
		"registry.getCanonicalRollup",
		await c.l1.readContract({ address: r.l1Registry, abi: RegistryAbi, functionName: "getCanonicalRollup", ...at(head) }),
		r.rollup,
	)
}

/** At one fresh head, never `finalized`: an upgrade already mined after the finalized block must fail here. */
async function checkRollup(c: OpenContext, head: Head): Promise<void> {
	await checkCanonicalRollup(c, head)
	const r = c.expected.rollup
	const rollup = { address: r.rollup, abi: RollupAbi, ...at(head) } as const
	same("rollup.getInbox", await c.l1.readContract({ ...rollup, functionName: "getInbox" }), r.inbox)
	same("rollup.getOutbox", await c.l1.readContract({ ...rollup, functionName: "getOutbox" }), r.outbox)
	same("rollup.getVersion", await c.l1.readContract({ ...rollup, functionName: "getVersion" }), r.rollupVersion)
	const info = await c.node.getNodeInfo()
	same("node.l1ChainId", info.l1ChainId, c.chainId)
	same("node.registry", info.l1ContractAddresses.registryAddress, r.l1Registry)
	same("node.rollup", info.l1ContractAddresses.rollupAddress, r.rollup)
	const node = await rollupEndpointsOf(c.node)
	same("node.inbox", node.inbox, r.inbox)
	same("node.outbox", node.outbox, r.outbox)
	same("node.rollupVersion", node.rollupVersion, r.rollupVersion)
}

/** The hub is salted with its factory and takes the registry and token class as constructor arguments. */
async function checkHub(c: OpenContext, tokenClassId: string): Promise<void> {
	same("hub address", (await deriveHub(tokenClassId, c.factory, c.registry)).address.toString(), c.hub)
	await assertV1Hub(c.node, AztecAddress.fromStringUnsafe(c.hub), tokenBridgeHubArtifact)
}

async function checkTokens(c: OpenContext, tokenClassId: string): Promise<void> {
	for (const p of c.portals) {
		if (!p.l2Token) continue
		same(`hub.token_of(${p.asset})`, await hubBindingAt(c.node, c.hub, p.asset), p.l2Token)
		const token = await c.node.getContract(AztecAddress.fromStringUnsafe(p.l2Token))
		same(`${p.l2Token} class`, token?.currentContractClassId, tokenClassId)
		if (!(await c.node.getContractClass(Fr.fromHexString(tokenClassId))))
			throw new OpenRefusedError("token class", `${tokenClassId} is not published`)
	}
}

/** PublicImmutable packs its value first in a WithHash, and PublicMutable of one field holds it, so each role sits at its base slot. */
async function readRole(c: OpenContext, name: "admin" | "poster" | "birth_intake"): Promise<string> {
	const slot = aspRootRegistryArtifact.storageLayout[name]?.slot
	if (!slot) throw new Error(`the registry artifact declares no ${name} storage`)
	return (await c.node.getPublicStorageAt("latest", AztecAddress.fromStringUnsafe(c.registry), slot)).toString()
}

async function checkRegistry(c: OpenContext): Promise<void> {
	const roles = c.expected.registryRoles
	if (c.registry.toLowerCase() === NO_ASP_REGISTRY) {
		if (roles) throw new OpenRefusedError("registry", "the zero registry runs no checked spends")
		return
	}
	const deployed = await c.node.getContract(AztecAddress.fromStringUnsafe(c.registry))
	same("registry class", deployed?.currentContractClassId, (await getContractClassFromArtifact(aspRootRegistryArtifact)).id)
	if (!roles) return
	same("registry.admin", await readRole(c, "admin"), roles.admin)
	same("registry.poster", await readRole(c, "poster"), roles.poster)
	same("registry.birth_intake", await readRole(c, "birth_intake"), roles.birthIntake)
}

/**
 * Reads only, and throws at the first disagreement, in order: chain ids; the L1 registry's canonical
 * rollup, its Inbox, Outbox and version, and the node's, all equal to `expected.rollup`; every factory
 * and implementation binding (the implementation is the factory's nonce-1 CREATE) and every portal;
 * the hub address recomputed from its constructor arguments, and its v1 class; each given L2 token's
 * binding and published class; the registry's class and, when given, its roles; no pending owner; and
 * that head still canonical. Every L1 read is at one head's hash.
 * @throws OpenRefusedError, BindingMismatchError or LegacyHubError; a failed read rejects with its own error.
 */
export async function checkBeforeOpen(c: OpenContext): Promise<void> {
	if (c.portals.length === 0) throw new OpenRefusedError("portals", "none given")
	same("l1.chainId", await c.l1.getChainId(), c.chainId)
	const head = await latestHead(c.l1)
	await checkRollup(c, head)
	const r = c.expected.rollup
	await assertGenerationBindings(
		c.l1,
		{
			factory: c.factory,
			implementation: getContractAddress({ from: c.factory, nonce: 1n }),
			hub: c.hub,
			guardian: c.expected.guardian,
			inbox: r.inbox,
			outbox: r.outbox,
			rollupVersion: r.rollupVersion,
			pool: c.expected.pool,
			lifetimeCap: c.expected.lifetimeCap,
			portals: c.portals.map((p) => ({ token: p.asset, portal: p.portal })),
		},
		"open",
		at(head),
	)
	const { tokenClassId } = await artifactClassIds()
	await checkHub(c, tokenClassId)
	await checkTokens(c, tokenClassId)
	await checkRegistry(c)
	await checkNoPendingOwner(c, head)
	if ((await c.l1.getBlock({ blockNumber: head.number })).hash !== head.hash)
		throw new OpenRefusedError("l1 head", "reorged during the check")
}

async function checkNoPendingOwner(c: OpenContext, head: Head): Promise<void> {
	same(
		"factory.pendingOwner",
		await c.l1.readContract({ address: c.factory, abi: PORTAL_FACTORY_ABI, functionName: "pendingOwner", ...at(head) }),
		ZERO_ADDRESS,
	)
}

/**
 * The last reads before an open broadcasts, at a fresh head: what can change between {@link checkBeforeOpen}
 * and the send without a deploy, the registry's canonical rollup and a pending ownership transfer.
 * @throws OpenRefusedError
 */
export async function checkStillOpenable(c: OpenContext): Promise<void> {
	const head = await latestHead(c.l1)
	await checkCanonicalRollup(c, head)
	await checkNoPendingOwner(c, head)
}

// ─── The guardian's writes ───────────────────────────────────────────────────

export type GuardianWallet = Pick<WalletClient, "prepareTransactionRequest" | "signTransaction" | "sendRawTransaction" | "getChainId"> & {
	account: Account
	chain?: Chain
}

export type GuardianL1 = OpenL1 &
	Pick<PublicClient, "waitForTransactionReceipt" | "getTransactionReceipt" | "getTransactionCount" | "estimateFeesPerGas">

/** Called with the signed transaction's hash and nonce before it is broadcast, so a lost response still names it. */
export type OnSigned = (s: { hash: Hash; nonce: number }) => void

async function assertGuardian(chainId: number, guardian: GuardianWallet, l1: OpenL1, want?: Address): Promise<void> {
	same("l1.chainId", await l1.getChainId(), chainId)
	same("wallet.chainId", await guardian.getChainId(), chainId)
	if (guardian.chain) same("wallet.chain", guardian.chain.id, chainId)
	if (want) same("guardian", guardian.account.address, want)
}

type Signed = { hash: Hash; nonce: number; serialized: Hex }

async function signEntriesPaused(
	l1: GuardianL1,
	guardian: GuardianWallet,
	factory: Address,
	paused: boolean,
	o: { nonce?: number; feeFactor?: bigint },
): Promise<Signed> {
	const data = encodeFunctionData({ abi: PORTAL_FACTORY_ABI, functionName: "setEntriesPaused", args: [paused] })
	const fees = o.feeFactor ? await l1.estimateFeesPerGas() : undefined
	const request = await guardian.prepareTransactionRequest({
		account: guardian.account,
		chain: guardian.chain,
		to: factory,
		data,
		...(o.nonce === undefined ? {} : { nonce: o.nonce }),
		...(fees && o.feeFactor
			? { maxFeePerGas: fees.maxFeePerGas * o.feeFactor, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * o.feeFactor }
			: {}),
	} as never)
	const serialized = (await guardian.signTransaction(request as never)) as Hex
	return { hash: keccak256(serialized), nonce: (request as { nonce: number }).nonce, serialized }
}

/** `entriesPaused` at `blockHash`, or at the latest block when absent. */
async function pausedAt(l1: OpenL1, factory: Address, blockHash?: Hash): Promise<boolean> {
	return l1.readContract({
		address: factory,
		abi: PORTAL_FACTORY_ABI,
		functionName: "entriesPaused",
		...(blockHash === undefined ? {} : { blockHash, requireCanonical: true }),
	})
}

/**
 * The later-process open. Refuses before any write unless `expected.registryRoles` is set, every
 * portal names its L2 token, the reader's, the wallet's and the node's L1 chain ids all equal
 * `c.chainId`, the account is the expected guardian, and {@link checkBeforeOpen} passes. Signs, runs
 * {@link checkStillOpenable}, reports the hash and nonce, then broadcasts; requires its own receipt,
 * successful, and entries open at the receipt's block.
 * @throws Error naming both hashes when another transaction at the nonce mined instead
 */
export async function openDeployedEntries(
	c: OpenContext & { l1: GuardianL1 },
	guardian: GuardianWallet,
	o: { timing?: ClientTiming; onSigned?: OnSigned } = {},
): Promise<Hash> {
	const l1 = c.l1
	if (!c.expected.registryRoles) throw new OpenRefusedError("registryRoles", "a later-process open checks the registry's roles")
	if (c.portals.some((p) => !p.l2Token)) throw new OpenRefusedError("portals", "every portal must name its L2 token")
	const timing = clientTiming(o.timing)
	await assertGuardian(c.chainId, guardian, l1, c.expected.guardian)
	await checkBeforeOpen(c)
	const signed = await signEntriesPaused(l1, guardian, c.factory, false, {})
	await checkStillOpenable(c)
	o.onSigned?.({ hash: signed.hash, nonce: signed.nonce })
	await guardian.sendRawTransaction({ serializedTransaction: signed.serialized })
	const receipt = await l1.waitForTransactionReceipt({
		hash: signed.hash,
		timeout: timing.receiptTimeoutMs,
		pollingInterval: timing.pollingIntervalMs,
	})
	if (receipt.transactionHash.toLowerCase() !== signed.hash.toLowerCase())
		throw new Error(`${receipt.transactionHash} mined at this open's nonce instead of ${signed.hash}`)
	if (receipt.status !== "success") throw new Error(`setEntriesPaused(false) reverted (${signed.hash})`)
	if (await pausedAt(l1, c.factory, receipt.blockHash)) throw new Error(`entries still paused at block ${receipt.blockNumber}`)
	return signed.hash
}

// ─── Pause ───────────────────────────────────────────────────────────────────

export type PauseCode = "PAUSE_BLOCKED" | "PAUSE_STALLED" | "PAUSE_NONCE_OCCUPIED" | "PAUSE_UNFINALIZED" | "PAUSE_UNCONFIRMED"

/** A pause that did not complete. `nonce` is the one the owner acts on: the gap, the stalled or the occupied one. */
export class PauseError extends Error {
	constructor(
		readonly code: PauseCode,
		readonly nonce: number,
		detail: string,
	) {
		super(`${code} at nonce ${nonce}: ${detail}`)
		this.name = "PauseError"
	}
}

export type PauseWaits = { stallMs: number; finalityMs: number }
export const PAUSE_WAITS: PauseWaits = Object.freeze({ stallMs: 600_000, finalityMs: 1_800_000 })

export type PauseOptions = {
	/** The owner's manual branch after PAUSE_BLOCKED, PAUSE_STALLED or PAUSE_NONCE_OCCUPIED. */
	nonce?: number
	/** Same-nonce replacement: four times the fee estimate instead of twice. */
	replace?: boolean
	timing?: ClientTiming
	waits?: PauseWaits
	onSigned?: OnSigned
}

export type PauseResult = { hash: Hash; nonce: number; wasPaused: boolean }

function errorText(e: unknown): string {
	const parts: string[] = []
	for (let cur = e as { message?: string; details?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur)
		parts.push(String(cur.message ?? ""), String(cur.details ?? ""))
	return parts.join("\n")
}

type Sent = Omit<Signed, "serialized"> & { taken?: true }

async function sendPause(l1: GuardianL1, guardian: GuardianWallet, factory: Address, o: PauseOptions, nonce?: number): Promise<Sent> {
	const address = guardian.account.address
	const chosen =
		nonce ??
		Math.max(
			await l1.getTransactionCount({ address, blockTag: "latest" }),
			await l1.getTransactionCount({ address, blockTag: "pending" }),
		)
	const signed = await signEntriesPaused(l1, guardian, factory, true, { nonce: chosen, feeFactor: o.replace ? 4n : 2n })
	o.onSigned?.({ hash: signed.hash, nonce: signed.nonce })
	const sent = { hash: signed.hash, nonce: signed.nonce }
	try {
		await guardian.sendRawTransaction({ serializedTransaction: signed.serialized })
		return sent
	} catch (e) {
		const text = errorText(e)
		if (/already known/i.test(text)) return sent
		if (/nonce too low/i.test(text)) return { ...sent, taken: true }
		if (/replacement transaction underpriced|replacement fee too low/i.test(text))
			throw new PauseError(
				"PAUSE_NONCE_OCCUPIED",
				signed.nonce,
				"a pending transaction holds this nonce; the open's hash is in its log",
			)
		throw e
	}
}

async function receiptOf(l1: GuardianL1, hash: Hash): Promise<TransactionReceipt | undefined> {
	try {
		return await l1.getTransactionReceipt({ hash })
	} catch (e) {
		if (/could not be found|not found/i.test(errorText(e))) return undefined
		throw e
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Receipt reads before a passed nonce counts as taken: the backend counting nonces can lead the one serving receipts. */
const OWN_RECEIPT_READS = 4

/** `hash`'s receipt, read up to {@link OWN_RECEIPT_READS} times, or "taken". */
async function ownReceipt(l1: GuardianL1, hash: Hash, timing: ClientTiming): Promise<TransactionReceipt | "taken"> {
	for (let read = 1; ; read++) {
		const receipt = await receiptOf(l1, hash)
		if (receipt) return receipt
		if (read === OWN_RECEIPT_READS) return "taken"
		await sleep(timing.pollingIntervalMs)
	}
}

/** Its receipt, or "taken" once the guardian's mined nonce passes it without one. */
async function awaitPause(
	l1: GuardianL1,
	address: Address,
	sent: Sent,
	timing: ClientTiming,
	waits: PauseWaits,
): Promise<TransactionReceipt | "taken"> {
	const deadline = Date.now() + waits.stallMs
	for (;;) {
		const receipt = await receiptOf(l1, sent.hash)
		if (receipt) return receipt
		const mined = await l1.getTransactionCount({ address, blockTag: "latest" })
		if (mined > sent.nonce) return ownReceipt(l1, sent.hash, timing)
		if (Date.now() >= deadline) {
			if (mined < sent.nonce)
				throw new PauseError("PAUSE_BLOCKED", mined, `nonce ${mined} has not mined, and this pause waits behind it`)
			throw new PauseError("PAUSE_STALLED", sent.nonce, "the next nonce has not mined at twice the fee estimate")
		}
		await sleep(timing.pollingIntervalMs)
	}
}

/**
 * "reopened" when entries are open at the pause's own block, or, once that block is canonical under a
 * finalized header, at that header's hash or a fresh head's, as an open queued behind a nonce gap the
 * pause filled leaves them; else "paused".
 */
async function confirmFinal(
	l1: GuardianL1,
	factory: Address,
	receipt: TransactionReceipt,
	nonce: number,
	timing: ClientTiming,
	waits: PauseWaits,
): Promise<"paused" | "reopened"> {
	if (receipt.status !== "success") throw new Error(`setEntriesPaused(true) reverted (${receipt.transactionHash})`)
	// An open queued right behind the pause can run after it in the same block.
	if (!(await pausedAt(l1, factory, receipt.blockHash))) return "reopened"
	const deadline = Date.now() + waits.finalityMs
	let finalized = await l1.getBlock({ blockTag: "finalized" })
	while (finalized.number < receipt.blockNumber) {
		if (Date.now() >= deadline)
			throw new PauseError("PAUSE_UNFINALIZED", nonce, `block ${receipt.blockNumber} is past finalized ${finalized.number}`)
		await sleep(timing.pollingIntervalMs)
		finalized = await l1.getBlock({ blockTag: "finalized" })
	}
	if ((await l1.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash)
		throw new PauseError("PAUSE_UNCONFIRMED", nonce, `the pause's block ${receipt.blockNumber} was reorged out`)
	const final = await pausedAt(l1, factory, finalized.hash)
	return final && (await pausedAt(l1, factory, (await latestHead(l1)).hash)) ? "paused" : "reopened"
}

const PAUSE_SENDS = 3

/** {@link confirmFinal} after a broadcast: a failed read there is `PAUSE_UNCONFIRMED` naming the send, never a bare RPC error. */
async function confirmed(
	l1: GuardianL1,
	factory: Address,
	receipt: TransactionReceipt,
	sent: Sent,
	timing: ClientTiming,
	waits: PauseWaits,
): Promise<"paused" | "reopened"> {
	try {
		return await confirmFinal(l1, factory, receipt, sent.nonce, timing, waits)
	} catch (e) {
		if (e instanceof PauseError) throw e
		throw new PauseError(
			"PAUSE_UNCONFIRMED",
			sent.nonce,
			`${sent.hash} mined; reading its state failed: ${e instanceof Error ? e.message : String(e)}`,
		)
	}
}

/**
 * Always writes `setEntriesPaused(true)` (idempotent on chain), at `o.nonce` if given, else at the
 * higher of the guardian's mined and pending nonce, so it mines after any open still in flight. Sends
 * again at a fresh nonce, at most {@link PAUSE_SENDS} sends in all, when another transaction takes its
 * nonce or entries are open again once its pause is final. Done only when its receipt succeeded, the
 * receipt's block is canonical under a finalized header with entries paused at its hash, and a fresh
 * head after that still has them paused. Needs only L1; never runs
 * {@link checkBeforeOpen}. No automatic fee replacement: the owner's manual branches are `o.nonce`
 * and `o.replace`.
 * @returns `wasPaused` is the read before sending, which an open still pending then does not show.
 * @throws PauseError naming what the owner acts on; `PAUSE_UNCONFIRMED` after the last send names its nonce.
 */
export async function pauseEntries(
	f: { chainId: number; l1: GuardianL1; factory: Address },
	guardian: GuardianWallet,
	o: PauseOptions = {},
): Promise<PauseResult> {
	await assertGuardian(f.chainId, guardian, f.l1)
	const timing = clientTiming(o.timing ?? LOCAL_TIMING)
	const waits = o.waits ?? PAUSE_WAITS
	const wasPaused = await pausedAt(f.l1, f.factory)
	let nonce = o.nonce
	let last = { nonce: -1, outcome: "taken" }
	for (let send = 0; send < PAUSE_SENDS; send++) {
		if (send > 0) await sleep(timing.pollingIntervalMs)
		const sent = await sendPause(f.l1, guardian, f.factory, o, nonce)
		const landed = sent.taken
			? await ownReceipt(f.l1, sent.hash, timing)
			: await awaitPause(f.l1, guardian.account.address, sent, timing, waits)
		const outcome = landed === "taken" ? landed : await confirmed(f.l1, f.factory, landed, sent, timing, waits)
		if (outcome === "paused") return { hash: sent.hash, nonce: sent.nonce, wasPaused }
		last = { nonce: sent.nonce, outcome }
		nonce = undefined
	}
	const why = last.outcome === "taken" ? "another transaction took the last send's nonce" : "entries reopened after the last pause"
	throw new PauseError("PAUSE_UNCONFIRMED", last.nonce, `${why}, after ${PAUSE_SENDS} sends`)
}
