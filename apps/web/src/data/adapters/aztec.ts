/**
 * Aztec for a stack build, through the connected wallet and nothing else. A send goes out only through
 * the wallet of the connection it is bound to, right after its handoff check, and only when every call
 * in it is granted as a transaction. The app registers only the hub and the token, as the grant allows.
 */
import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { type AztecNode, createAztecNodeClient, waitForTx } from "@aztec-labs/aztec.js/node"
import { type ExecutionPayload, TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import type { Hex } from "viem"
import { BridgeFailure, isUserRejection } from "../errors"
import { BALANCES_PAGE, NOTES_PAGE, readAllPages } from "../paging"
import { parseAztecAddress, parseBalanceRow, parseU128 } from "../parse"
import type { AztecPort, AztecReceipt, Deployment, LabelBalance, Sent } from "../ports"
import type { AztecAddress } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { type ScopeBucket, scopeKey } from "../wallet/grant"

/** The app's own contracts, the only ones it registers. */
export type AppContract = "hub" | "token"

const ARTIFACTS = { hub: tokenBridgeHubArtifact, token: labelledTokenArtifact } as const

/** A claim on the local network lands in a proposed block within seconds; past this the outcome is unknown, not dropped. */
const SEND_TIMEOUT_S = 180

export interface AztecDeps {
	deployment: Pick<Deployment, AppContract | "chainId">
	node: Pick<AztecNode, "getContract" | "getTxReceipt" | "getNodeInfo">
	/** The live connection's wallet, or `null`. */
	current(): HeldWallet | null
}

/** The deps over the target's node; `current` is the page's connector's. */
export function aztecDeps(nodeUrl: string, deployment: AztecDeps["deployment"], current: AztecDeps["current"]): AztecDeps {
	return { deployment, node: createAztecNodeClient(nodeUrl), current }
}

export interface AztecSend {
	/** The connection the send is bound to: it goes out through that connection's wallet or not at all. */
	readonly epoch: number
	readonly from: AztecAddress
	/** Already paid by the SponsoredFPC. */
	readonly payload: ExecutionPayload
	/** The contracts the payload's private calls run, which the wallet must know. */
	readonly contracts: readonly AppContract[]
	/** Runs right before the wallet is asked to send; when it throws, nothing is sent. */
	handoff(): void
}

const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

/** Whether `p` calls something, and every function it calls was granted under `bucket`. */
export function grantedPayload(held: HeldWallet, bucket: ScopeBucket, p: Pick<ExecutionPayload, "calls">): boolean {
	return (
		p.calls.length > 0 &&
		p.calls.every((c) => {
			const to = parseAztecAddress(c.to)
			return to !== null && held.grant.scopes.has(scopeKey(bucket, to, c.name))
		})
	)
}

/** The live connection's wallet when it is connection `epoch`'s. */
export function boundTo(d: Pick<AztecDeps, "current">, epoch: number): HeldWallet {
	const held = d.current()
	if (held === null || held.epoch !== epoch) throw new BridgeFailure("CONTEXT_CHANGED")
	return held
}

const registrations = new WeakMap<Wallet, Map<string, Promise<void>>>()

async function register(d: AztecDeps, wallet: Wallet, c: AppContract): Promise<void> {
	const address = d.deployment[c]
	const instance = await d.node.getContract(sdk(address))
	if (!instance || parseAztecAddress(instance.address) !== address) throw new BridgeFailure("DEPLOYMENT_MISMATCH")
	await wallet.registerContract(instance, ARTIFACTS[c])
}

/** Teaches `held`'s wallet each of `which` once, and only a contract the grant lets the app register. */
export async function registerScoped(d: AztecDeps, held: HeldWallet, which: readonly AppContract[]): Promise<void> {
	const known = registrations.get(held.wallet) ?? new Map<string, Promise<void>>()
	registrations.set(held.wallet, known)
	for (const c of which) {
		const address = d.deployment[c]
		if (!held.grant.contracts.includes(address)) throw new BridgeFailure("NOT_GRANTED")
		let done = known.get(address)
		if (done === undefined) {
			done = register(d, held.wallet, c)
			known.set(address, done)
			done.catch(() => known.delete(address))
		}
		await done
	}
}

/**
 * Waits for a proposed block. A dropped transaction is an answer; a timeout or a failed read is not,
 * and keeps the hash the wallet returned as `unconfirmed`.
 */
async function settle(node: AztecDeps["node"], txHash: TxHash): Promise<Sent> {
	const hash = txHash.toString() as Hex
	const opts = { waitForStatus: TxStatus.PROPOSED, dontThrowOnRevert: true, timeout: SEND_TIMEOUT_S }
	try {
		const receipt = await waitForTx(node as AztecNode, txHash, opts)
		if (receipt.hasExecutionSucceeded()) return { txHash: hash, status: "success" }
		if (!receipt.isMined()) throw new BridgeFailure("RPC_INCONSISTENT")
		return { txHash: hash, status: "reverted", block: Number(receipt.blockNumber) }
	} catch {
		const receipt = await node.getTxReceipt(txHash).catch(() => null)
		return { txHash: hash, status: receipt?.isDropped() ? "dropped" : "unconfirmed" }
	}
}

type Accounts = Awaited<ReturnType<Wallet["getAccounts"]>>
type Chain = Awaited<ReturnType<Wallet["getChainInfo"]>>

/** An entry the wallet lists, read as untrusted: anything that is no account names none. */
const listedAccount = (entry: unknown): AztecAddress | null =>
	parseAztecAddress(entry !== null && typeof entry === "object" ? (entry as { item?: unknown }).item : undefined)

/** Whether the wallet still lists `from`, and it and the node sit on the deployment's chain and the node's rollup. */
function assertWalletStill(
	accounts: Accounts,
	chain: Chain,
	node: { l1ChainId: number; rollupVersion: number },
	d: Pick<AztecDeps, "deployment">,
	from: AztecAddress,
) {
	if (!Array.isArray(accounts) || !accounts.some((a) => listedAccount(a) === from)) throw new BridgeFailure("RECIPIENT_NOT_IN_WALLET")
	if (!sameChain(chain, node, BigInt(d.deployment.chainId))) throw new BridgeFailure("CONTEXT_CHANGED")
}

/** Whether the wallet and the node sit on L1 chain `l1` and one rollup; a malformed answer names none. */
function sameChain(chain: Chain, node: { l1ChainId: number; rollupVersion: number }, l1: bigint): boolean {
	try {
		const rollup = BigInt(node.rollupVersion)
		return BigInt(node.l1ChainId) === l1 && chain.chainId.toBigInt() === l1 && chain.version.toBigInt() === rollup
	} catch {
		return false
	}
}

/**
 * One Aztec send. Every refusal is thrown before `handoff`, so the caller knows nothing was sent. The
 * grant is the connect's snapshot, and a wallet can drop an account or move to another rollup over the
 * same channel without disconnecting, so its own answers are read again, its accounts last. The scopes
 * it granted cannot be read back without asking the user again; they stay the connect's.
 */
export async function sendThroughWallet(d: AztecDeps, s: AztecSend): Promise<Sent> {
	const first = boundTo(d, s.epoch)
	if (!first.grant.accounts.includes(s.from)) throw new BridgeFailure("RECIPIENT_NOT_IN_WALLET")
	if (!grantedPayload(first, "transaction", s.payload)) throw new BridgeFailure("NOT_GRANTED")
	await registerScoped(d, first, s.contracts)
	const [chain, node] = await Promise.all([first.wallet.getChainInfo(), d.node.getNodeInfo()])
	const accounts = await first.wallet.getAccounts()
	// Nothing awaits between the last read, these checks, the handoff and the wallet call.
	assertWalletStill(accounts, chain, node, d, s.from)
	const held = boundTo(d, s.epoch)
	s.handoff()
	let txHash: TxHash
	try {
		;({ txHash } = await held.wallet.sendTx(s.payload, { from: sdk(s.from), wait: NO_WAIT }))
	} catch (err) {
		// The wallet's no sent nothing; any other failure past the handoff may follow a broadcast.
		if (isUserRejection(err)) throw err
		return { status: "unconfirmed" }
	}
	return settle(d.node, txHash)
}

/** How the node reads `txHash` now. A mined receipt without a block is no answer. */
export async function readReceipt(node: Pick<AztecNode, "getTxReceipt">, txHash: Hex): Promise<AztecReceipt> {
	const r = await node.getTxReceipt(TxHash.fromString(txHash))
	if (!r.isMined()) return { status: "pending" }
	if (r.hasExecutionSucceeded()) return { status: "success" }
	const block = Number(r.blockNumber)
	if (!Number.isSafeInteger(block)) throw new BridgeFailure("RPC_INCONSISTENT")
	return { status: "reverted", block }
}

/** A simulation's return value, whether aztec.js hands it back bare or under `result`. */
const resultOf = (v: unknown): unknown => (v && typeof v === "object" && "result" in v ? v.result : v)

/** A `BoundedVec` as aztec.js decodes it, cut to its length; a length that is no count reads as empty. */
export function entries(v: unknown): unknown[] {
	const page = resultOf(v) as { storage?: unknown; len?: unknown } | null
	if (!page || !Array.isArray(page.storage) || (typeof page.len !== "bigint" && typeof page.len !== "number")) return []
	const len = Number(page.len)
	return Number.isSafeInteger(len) && len >= 0 ? page.storage.slice(0, len) : []
}

const fields = (row: unknown): unknown[] => (row && typeof row === "object" ? Object.values(row) : [])

async function tokenAs(d: AztecDeps, owner: AztecAddress): Promise<Contract> {
	const held = d.current()
	if (held === null) throw new BridgeFailure("CONTEXT_CHANGED")
	if (!held.grant.accounts.includes(owner)) throw new BridgeFailure("RECIPIENT_NOT_IN_WALLET")
	await registerScoped(d, held, ["token"])
	return Contract.at(sdk(d.deployment.token), labelledTokenArtifact, held.wallet)
}

/**
 * Note values as the wallet lists them, read as untrusted: anything that is no u128 is dropped, and so
 * is a zero, which the token never writes and a ragequit cannot burn.
 */
export const noteValues = (values: readonly unknown[]): bigint[] => values.map(parseU128).filter((v): v is bigint => v !== null && v > 0n)

/** The token's views over the live connection. */
export function stackAztec(d: AztecDeps): Pick<AztecPort, "balancesByLabel" | "notesByLabel" | "publicBalance"> {
	return {
		async balancesByLabel(owner) {
			const token = await tokenAs(d, owner)
			const from = sdk(owner)
			const page = async (start: number) => entries(await token.methods.private_balances_by_label(from, start).simulate({ from }))
			const rows = await readAllPages(page, BALANCES_PAGE)
			return rows.map((r) => parseBalanceRow(fields(r))).filter((b): b is LabelBalance => b !== null)
		},
		async notesByLabel(owner, label) {
			const token = await tokenAs(d, owner)
			const from = sdk(owner)
			const page = async (start: number) => entries(await token.methods.private_notes_by_label(from, label, start).simulate({ from }))
			return noteValues(await readAllPages(page, NOTES_PAGE))
		},
		async publicBalance(owner) {
			const token = await tokenAs(d, owner)
			const from = sdk(owner)
			const balance = parseU128(resultOf(await token.methods.balance_of_public(from).simulate({ from })))
			if (balance === null) throw new BridgeFailure("RPC_INCONSISTENT")
			return balance
		},
	}
}
