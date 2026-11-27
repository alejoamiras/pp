/**
 * Aztec for a stack build, through the connected wallet and nothing else. A read runs the token's
 * utilities as its owner. A send names its account, carries the SponsoredFPC's payment inside its
 * payload, and goes out only through the wallet of the connection it is bound to, right after its
 * handoff check; every function it calls must be granted as a transaction before the wallet sees it.
 * The wallet learns the hub and the token on first use, and only those the grant lets it register.
 */
import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { type AztecNode, createAztecNodeClient, waitForTx } from "@aztec-labs/aztec.js/node"
import { type ExecutionPayload, type TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import type { Hex } from "viem"
import { BridgeFailure } from "../errors"
import { BALANCES_PAGE, NOTES_PAGE, readAllPages } from "../paging"
import { parseAztecAddress, parseBalanceRow, parseU128 } from "../parse"
import type { AztecPort, Deployment, LabelBalance, Sent } from "../ports"
import type { AztecAddress } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { type ScopeBucket, scopeKey } from "../wallet/grant"

/** The app's own contracts, the only ones it registers. */
export type AppContract = "hub" | "token"

const ARTIFACTS = { hub: tokenBridgeHubArtifact, token: labelledTokenArtifact } as const

/** A claim on the local network lands in a proposed block within seconds; past this the outcome is unknown, not dropped. */
const SEND_TIMEOUT_S = 180

export interface AztecDeps {
	deployment: Pick<Deployment, AppContract>
	node: Pick<AztecNode, "getContract" | "getTxReceipt">
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

/** Whether every function `p` calls was granted under `bucket`. */
export function grantedPayload(held: HeldWallet, bucket: ScopeBucket, p: Pick<ExecutionPayload, "calls">): boolean {
	return p.calls.every((c) => {
		const to = parseAztecAddress(c.to)
		return to !== null && held.grant.scopes.has(scopeKey(bucket, to, c.name))
	})
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

/** Waits for a proposed block. A dropped transaction is an answer; a timeout or a failed read is not. */
async function settle(node: AztecDeps["node"], txHash: TxHash): Promise<Sent> {
	const hash = txHash.toString() as Hex
	const opts = { waitForStatus: TxStatus.PROPOSED, dontThrowOnRevert: true, timeout: SEND_TIMEOUT_S }
	try {
		const receipt = await waitForTx(node as AztecNode, txHash, opts)
		return { txHash: hash, status: receipt.hasExecutionSucceeded() ? "success" : "reverted" }
	} catch (err) {
		if ((await node.getTxReceipt(txHash)).isDropped()) return { txHash: hash, status: "dropped" }
		throw err
	}
}

/** One Aztec send. Every refusal is thrown before `handoff`, so the caller knows nothing was sent. */
export async function sendThroughWallet(d: AztecDeps, s: AztecSend): Promise<Sent> {
	const first = boundTo(d, s.epoch)
	if (!first.grant.accounts.includes(s.from)) throw new BridgeFailure("RECIPIENT_NOT_IN_WALLET")
	if (!grantedPayload(first, "transaction", s.payload)) throw new BridgeFailure("NOT_GRANTED")
	await registerScoped(d, first, s.contracts)
	// Nothing awaits between this check, the handoff and the wallet call.
	const held = boundTo(d, s.epoch)
	s.handoff()
	const { txHash } = await held.wallet.sendTx(s.payload, { from: sdk(s.from), wait: NO_WAIT })
	return settle(d.node, txHash)
}

/** A `BoundedVec` as aztec.js decodes it, cut to its length. */
function entries(v: unknown): unknown[] {
	const page = (v && typeof v === "object" && "result" in v ? v.result : v) as { storage?: unknown; len?: unknown } | null
	if (!page || !Array.isArray(page.storage) || (typeof page.len !== "bigint" && typeof page.len !== "number")) return []
	return page.storage.slice(0, Number(page.len))
}

const fields = (row: unknown): unknown[] => (row && typeof row === "object" ? Object.values(row) : [])

async function tokenAs(d: AztecDeps, owner: AztecAddress): Promise<Contract> {
	const held = d.current()
	if (held === null) throw new BridgeFailure("CONTEXT_CHANGED")
	if (!held.grant.accounts.includes(owner)) throw new BridgeFailure("RECIPIENT_NOT_IN_WALLET")
	await registerScoped(d, held, ["token"])
	return Contract.at(sdk(d.deployment.token), labelledTokenArtifact, held.wallet)
}

/** The token's views over the live connection. */
export function stackAztec(d: AztecDeps): Pick<AztecPort, "balancesByLabel" | "notesByLabel"> {
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
			const values = await readAllPages(page, NOTES_PAGE)
			return values.map(parseU128).filter((v): v is bigint => v !== null)
		},
	}
}
