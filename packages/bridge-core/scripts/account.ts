/**
 * Aztec devices and accounts on whichever network a manifest names: nothing here funds, seeds or
 * assumes a local chain. A device is an embedded wallet that knows the SponsoredFPC, the hub and its
 * token; an account is a constructor-based Schnorr account under the Nulo wallet's key derivation,
 * registered in one device.
 */
import type { CompleteAddress } from "@aztec-labs/aztec.js/addresses"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { type ExecutionPayload, type Tx, TxExecutionResult, type TxHash, type TxReceipt, TxStatus } from "@aztec-labs/stdlib/tx"
import type { Hex } from "viem"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../src/artifacts"
import type { KeyValueStore } from "../src/client/journal"
import { actorAccount } from "./sandbox/l2"
import { createL2Wallet, createNode } from "./script-bootstrap"
import { deployAccountIfAbsent, sponsoredFpcFee } from "./script-l2"

/** What a device reads from a manifest: the node and the bridge's two L2 contracts. */
export type DeviceTarget = { aztecNode: string; bridge: { hub: string; token: string } }

export type Device = {
	wallet: Awaited<ReturnType<typeof createL2Wallet>>
	node: AztecNode
	hub: AztecAddress
	token: AztecAddress
	stop(): Promise<void>
}

export type DeviceOptions = {
	dataDirectory?: string
	knowsFpc?: boolean
	/** Default true: every key the wallet holds is worthless off a local network. */
	sandboxKeysOnly?: boolean
	/** Default false; a public network refuses a transaction without a real proof. */
	proverEnabled?: boolean
}

/**
 * A device: an embedded wallet that knows the SponsoredFPC (unless `knowsFpc` is false), the hub and
 * its token. Its store is `dataDirectory` when given, else one this process owns and removes; with
 * `sandboxKeysOnly` false the store needs a tmpfs `/dev/shm` (`createL2Wallet`).
 */
export async function device(m: DeviceTarget, o: DeviceOptions = {}): Promise<Device> {
	const wallet = await createL2Wallet({
		nodeUrl: m.aztecNode,
		proverEnabled: o.proverEnabled ?? false,
		sandboxKeysOnly: o.sandboxKeysOnly ?? true,
		dataDirectory: o.dataDirectory,
	})
	try {
		const node = createNode(m.aztecNode)
		const hub = AztecAddress.fromStringUnsafe(m.bridge.hub)
		const token = AztecAddress.fromStringUnsafe(m.bridge.token)
		if (o.knowsFpc !== false) await sponsoredFpcFee(wallet)
		for (const [address, artifact] of [
			[hub, tokenBridgeHubArtifact],
			[token, labelledTokenArtifact],
		] as const) {
			const instance = await node.getContract(address)
			if (!instance) throw new Error(`the node does not serve ${address}`)
			await wallet.registerContract(instance, artifact)
		}
		return { wallet, node, hub, token, stop: () => wallet.stop() }
	} catch (e) {
		await wallet.stop()
		throw e
	}
}

/** A transaction proven exactly as its wallet would send it, and not broadcast. */
export type ProvenTx = {
	tx: Tx
	txHash: TxHash
	/** The block the proof reads its private state at: its number, hash and timestamp. */
	anchor: { number: number; hash: Hex; timestamp: bigint }
}

export type Account = {
	address: AztecAddress
	secret: Hex
	completeAddress: CompleteAddress
	deploy(): Promise<void>
	/** Deploys the account and runs `payload` through its own entrypoint in the same transaction, paid as `payload` says. */
	deployWith(payload: ExecutionPayload): Promise<{ transactionFee?: bigint; blockNumber?: unknown }>
	/** `deployWith`'s transaction, proven and not sent: its hash is known before anything reaches the node. */
	proveDeployAndClaim(payload: ExecutionPayload): Promise<ProvenTx>
	/** `payload` from the deployed account, proven and not sent; paid as `payload` says. */
	prove(payload: ExecutionPayload): Promise<ProvenTx>
}

type DeployManager = { getDeployMethod(): Promise<{ send(o: unknown): Promise<unknown> }> }

/** A self-paid deploy's options: the payment method hands the new account's entrypoint `payload`. */
function selfPaid(payload: ExecutionPayload) {
	// A self-paid deploy wraps its payment method's payload in the new account's entrypoint, after
	// the constructor: handing it the claim makes the account the claim's sender.
	const feePayer = payload.feePayer
	if (!feePayer) throw new Error("the payload names no fee payer")
	const paymentMethod = {
		getAsset: async () => ProtocolContractAddress.FeeJuice,
		getExecutionPayload: async () => payload,
		getFeePayer: async () => feePayer,
		getGasSettings: () => undefined,
	}
	return { from: NO_FROM, fee: { paymentMethod } }
}

/** The account `secret` derives at the sandbox salt, registered in `d`'s wallet and not deployed. */
export async function account(d: Device, secret: Hex): Promise<Account> {
	const { address, completeAddress, manager } = await actorAccount(d.wallet, secret)
	const deployMethod = () => (manager as unknown as DeployManager).getDeployMethod()
	return {
		address,
		secret,
		completeAddress,
		async deploy() {
			const { fee } = await sponsoredFpcFee(d.wallet)
			await deployAccountIfAbsent({ node: d.node as never, manager: manager as never, from: address, fee, log: () => {} })
		},
		async deployWith(payload) {
			const options = selfPaid(payload)
			const method = await deployMethod()
			const sent = (await method.send({ ...options, wait: { waitForStatus: TxStatus.PROPOSED } })) as {
				receipt: { transactionFee?: bigint; blockNumber?: unknown }
			}
			return sent.receipt
		},
		async proveDeployAndClaim(payload) {
			const options = selfPaid(payload)
			const method = await deployMethod()
			return proveOnly(d.wallet, () => method.send(options))
		},
		prove: (payload) => proveOnly(d.wallet, () => d.wallet.sendTx(payload, { from: address })),
	}
}

/** Sends `payload` from `from` as an app would: no fee option, so whatever pays is the payload's. */
export async function send(d: Device, from: AztecAddress, payload: ExecutionPayload) {
	const { receipt } = await d.wallet.sendTx(payload, { from, wait: { waitForStatus: TxStatus.PROPOSED } })
	return receipt
}

/** A journal that lives as long as the process: a script that bridges once needs no other. */
export const memoryJournal = (): KeyValueStore => {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

/** What `proveOnly` reads of the PXE's proving result. */
export type ProvingResult = {
	toTx(): Promise<Tx>
	publicInputs: {
		constants: {
			anchorBlockHeader: {
				getBlockNumber(): number
				hash(): Promise<{ toString(): string }>
				globalVariables: { timestamp: bigint }
			}
		}
	}
}

type ProvingPxe = { proveTx(...args: unknown[]): Promise<ProvingResult> }

/** Carries the proven result out of the wallet's send, which never reaches its node. */
class Proved extends Error {
	constructor(readonly result: ProvingResult) {
		super("proved and not sent")
	}
}

/** PXEs a `proveOnly` is patching. Two calls on one PXE would restore each other's patch out of order and let a send broadcast. */
const patching = new WeakSet<object>()

/**
 * Runs `send` through the wallet up to its proof and returns the transaction it would have broadcast.
 * The wallet's own path (its simulation, gas estimate, fee options and authwits) builds the proof; the
 * proof is taken from its PXE, a protected member of aztec.js's `BaseWallet` that the `Wallet`
 * interface does not offer: re-check it on every `@aztec-labs` bump. One call per wallet at a time.
 * @throws whatever `send` throws before its proof; Error when it returns without proving, or when
 * another `proveOnly` is running on the same wallet
 */
export async function proveOnly(wallet: unknown, send: () => Promise<unknown>): Promise<ProvenTx> {
	const pxe = (wallet as { pxe: ProvingPxe }).pxe
	if (patching.has(pxe)) throw new Error("a proveOnly is already running on this wallet; prove one transaction at a time")
	patching.add(pxe)
	const own = Object.hasOwn(pxe, "proveTx")
	const proveTx = pxe.proveTx
	pxe.proveTx = async (...args) => {
		throw new Proved(await proveTx.apply(pxe, args))
	}
	try {
		await send()
	} catch (e) {
		if (e instanceof Proved) return provenOf(e.result)
		throw e
	} finally {
		if (own) pxe.proveTx = proveTx
		else Reflect.deleteProperty(pxe, "proveTx")
		patching.delete(pxe)
	}
	throw new Error("the wallet returned from a send without proving it")
}

async function provenOf(r: ProvingResult): Promise<ProvenTx> {
	const tx = await r.toTx()
	const header = r.publicInputs.constants.anchorBlockHeader
	return {
		tx,
		txHash: tx.getTxHash(),
		anchor: {
			number: Number(header.getBlockNumber()),
			hash: (await header.hash()).toString() as Hex,
			timestamp: header.globalVariables.timestamp,
		},
	}
}

export type SendNode = Pick<AztecNode, "sendTx" | "getTxReceipt">

/**
 * A send's end. `unresolved` is every outcome that leaves the transaction's fate open: the node
 * refused or failed the send, a receipt read failed, or the wait ended with the transaction unseen or
 * `DROPPED` (a second backend reports that while propagation is incomplete). Its caller must not send
 * the same intent again.
 */
type Ending =
	| { status: "checkpointed"; receipt: TxReceipt }
	| { status: "reverted"; receipt: TxReceipt }
	| { status: "unresolved"; reason: "send" | "read" | "dropped" | "timeout" }

export type SendOutcome = {
	txHash: TxHash
	/** From the send to the outcome. */
	ms: number
	/** From the send to the first receipt in a block, when one was seen. */
	proposedMs?: number
} & Ending

const CHECKPOINTED_OR_LATER: readonly string[] = [TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED]
const IN_A_BLOCK: readonly string[] = [TxStatus.PROPOSED, ...CHECKPOINTED_OR_LATER]

/** How a receipt ends the wait, or undefined while it goes on. */
function endingOf(receipt: TxReceipt, timedOut: boolean): Ending | undefined {
	if (CHECKPOINTED_OR_LATER.includes(receipt.status))
		return { status: receipt.executionResult === TxExecutionResult.SUCCESS ? "checkpointed" : "reverted", receipt }
	if (timedOut) return { status: "unresolved", reason: receipt.status === TxStatus.DROPPED ? "dropped" : "timeout" }
	return undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Sends a proven transaction once and polls its receipt every `pollMs` (default 2 s) until it is
 * checkpointed or `l2WaitTimeoutSec` passes. Never sends twice and never retries a failed read.
 */
export async function sendAndWait(
	node: SendNode,
	proven: Pick<ProvenTx, "tx" | "txHash">,
	o: { l2WaitTimeoutSec: number; pollMs?: number },
): Promise<SendOutcome> {
	const { txHash } = proven
	const start = Date.now()
	const end = start + o.l2WaitTimeoutSec * 1000
	let proposedMs: number | undefined
	const done = (e: Ending): SendOutcome => ({ txHash, ms: Date.now() - start, ...(proposedMs === undefined ? {} : { proposedMs }), ...e })
	const sent = await node.sendTx(proven.tx).then(
		() => true,
		() => false,
	)
	if (!sent) return done({ status: "unresolved", reason: "send" })
	for (;;) {
		const receipt = await node.getTxReceipt(txHash).catch(() => undefined)
		if (!receipt) return done({ status: "unresolved", reason: "read" })
		if (proposedMs === undefined && IN_A_BLOCK.includes(receipt.status)) proposedMs = Date.now() - start
		const ending = endingOf(receipt, Date.now() >= end)
		if (ending) return done(ending)
		await sleep(Math.min(o.pollMs ?? 2_000, Math.max(0, end - Date.now())))
	}
}
