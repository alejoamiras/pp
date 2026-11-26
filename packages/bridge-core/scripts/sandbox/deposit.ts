/** The harness's L1 deposit: approve the token's portal and call it directly. Test plumbing that keeps
 *  deposit → claim → exit covered end to end; it is not a user-facing deposit API. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Address, erc20Abi, type Hex, type Log, parseEventLogs } from "viem"
import { deriveTokenClaimSecret } from "../../src/claim-secret"
import { TOKEN_PORTAL_ABI } from "../../src/factory-abi"
import type { Registration } from "../../src/factory-registry"
import type { L1Ctx } from "../../src/flows"
import { deriveHubTokenInstance } from "../../src/hub-token"
import type { JournalTokenBlock } from "../../src/journal"
import { fromWord } from "../../src/register-hash"
import { ensurePortal, sendGasLimit } from "../generation"

export interface PortalDepositParams {
	factory: Address
	/** The generation's hub and Token class: the L2 token is derived from them, never read. */
	hub: string
	tokenClassId: string
	erc20: Address
	amount: bigint
	recipient: string
	isPrivate: boolean
}

export interface PortalDepositResult {
	/** The factory's registration as a claim reads it. */
	token: JournalTokenBlock
	/** PRIVATE: the claim salt (`claim_private` re-derives the secret from it and the recipient).
	 *  PUBLIC: the secret itself. */
	claimValueHex: string
	secretHashHex: Hex
	leafIndex: bigint
	/** The L1→L2 message hash, to wait for before claiming. */
	messageHashHex: Hex
	txHash: Hex
}

async function assertDepositable(p: PortalDepositParams): Promise<AztecAddress> {
	if (p.amount <= 0n) throw new Error(`deposit amount must be positive, got ${p.amount}`)
	const recipient = AztecAddress.fromStringUnsafe(p.recipient)
	// A recipient off the Grumpkin curve mints a note nobody can decrypt, and the message commits to it.
	if (recipient.isZero() || !(await recipient.isValid())) throw new Error(`deposit recipient ${p.recipient} is not a valid Aztec address`)
	return recipient
}

async function tokenBlockOf(p: PortalDepositParams, reg: Registration): Promise<JournalTokenBlock> {
	const words = { nameWord: reg.nameWord, symbolWord: reg.symbolWord, decimals: reg.decimals }
	const instance = await deriveHubTokenInstance(AztecAddress.fromStringUnsafe(p.hub), p.erc20, words, p.tokenClassId)
	return {
		erc20: p.erc20.toLowerCase(),
		portal: reg.portal.toLowerCase(),
		l2Token: instance.address.toString(),
		nameWord: reg.nameWord,
		symbolWord: reg.symbolWord,
		decimals: reg.decimals,
		displaySymbol: fromWord(reg.symbolWord),
		registerKey: reg.registerKey,
		registerIndex: reg.registerIndex.toString(),
	}
}

/** `inbox` marks a call that sends an Inbox message, which gets the headroom a bare estimate lacks. */
async function sendAndConfirm(l1: L1Ctx, call: Record<string, unknown>, what: string, inbox: boolean): Promise<{ hash: Hex; logs: Log[] }> {
	const gas = inbox ? sendGasLimit(await l1.pub.estimateContractGas({ ...call, account: l1.account } as never)) : undefined
	const hash = await l1.wallet.writeContract({ ...call, account: l1.account, chain: l1.wallet.chain, gas } as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`${what} REVERTED (${hash})`)
	// viem follows a replacement; the receipt's hash is the transaction whose logs these are.
	return { hash: receipt.transactionHash, logs: receipt.logs }
}

/**
 * The leaf comes from the portal's own event and nothing else: a hostile token can emit a look-alike
 * `DepositToAztec*` during `transferFrom`, so only logs emitted at the portal's address count, exactly
 * one of them, and every field it carries must be the deposit just made.
 */
export function readPortalDeposit(
	logs: Log[],
	portal: string,
	expected: { amount: bigint; secretHash: Hex; to?: Hex },
): { key: Hex; index: bigint } {
	const own = parseEventLogs({ abi: TOKEN_PORTAL_ABI, logs }).filter((l) => l.address.toLowerCase() === portal.toLowerCase())
	const [ev, ...extra] = own
	if (!ev || extra.length > 0) throw new Error(`expected one deposit event from the portal ${portal}, found ${own.length}`)
	const wantName = expected.to === undefined ? "DepositToAztecPrivate" : "DepositToAztecPublic"
	if (ev.eventName !== wantName) throw new Error(`the portal emitted ${ev.eventName}, expected ${wantName}`)
	const args = ev.args as { amount: bigint; key: Hex; index: bigint; to?: Hex; secretHash?: Hex; secretHashForL2MessageConsumption?: Hex }
	const secretHash = args.secretHash ?? args.secretHashForL2MessageConsumption
	if (args.amount !== expected.amount)
		throw new Error(`the portal's event says amount ${args.amount}, the deposit sent ${expected.amount}`)
	if (secretHash?.toLowerCase() !== expected.secretHash.toLowerCase()) throw new Error("the portal's event carries another secret hash")
	if (expected.to !== undefined && args.to?.toLowerCase() !== expected.to.toLowerCase()) {
		throw new Error(`the portal's event names recipient ${args.to}, the deposit sent ${expected.to}`)
	}
	return { key: args.key, index: args.index }
}

/**
 * Creates the token's portal when the factory has none, approves it for `amount` and deposits.
 * Every check that can refuse runs before the first write.
 * @throws on a non-positive amount, an invalid recipient, a reverted transaction, or a deposit event
 *   that is missing, duplicated or disagrees with the call.
 */
export async function depositViaPortal(l1: L1Ctx, p: PortalDepositParams): Promise<PortalDepositResult> {
	const recipient = await assertDepositable(p)
	const { reg } = await ensurePortal(l1, p.factory, p.erc20)
	const token = await tokenBlockOf(p, reg)
	const portal = reg.portal
	const claimValue = Fr.random()
	const secret = p.isPrivate ? deriveTokenClaimSecret(claimValue, recipient) : claimValue
	const secretHash = (await computeSecretHash(secret)).toString() as Hex
	await sendAndConfirm(
		l1,
		{ address: p.erc20, abi: erc20Abi, functionName: "approve", args: [portal, p.amount] },
		`approve(${portal}, ${p.amount})`,
		false,
	)
	const to = recipient.toString() as Hex
	const call = p.isPrivate
		? { address: portal, abi: TOKEN_PORTAL_ABI, functionName: "depositToAztecPrivate", args: [p.amount, secretHash] }
		: { address: portal, abi: TOKEN_PORTAL_ABI, functionName: "depositToAztecPublic", args: [to, p.amount, secretHash] }
	const { hash, logs } = await sendAndConfirm(l1, call, `${call.functionName}(${p.erc20})`, true)
	const { key, index } = readPortalDeposit(logs, portal, { amount: p.amount, secretHash, to: p.isPrivate ? undefined : to })
	return {
		token,
		claimValueHex: claimValue.toString(),
		secretHashHex: secretHash,
		leafIndex: index,
		messageHashHex: key,
		txHash: hash,
	}
}
