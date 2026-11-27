/**
 * The bridge suite's actors on the attached stack: pool owners, Ethereum senders and Aztec devices.
 * Owners and senders sign from mnemonic indices far above the stack's own (0 for the node's
 * publisher, 12 to 15 for the demo, pp-env and the bridge deployer), funded here, and drawn afresh
 * per process, so a re-run on a kept stack never meets a registered owner or a used nonce.
 */
import type { CompleteAddress } from "@aztec-labs/aztec.js/addresses"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { type ExecutionPayload, TxStatus } from "@aztec-labs/stdlib/tx"
import { anvilAccount, circuitsDir, type Seeder, seeder } from "@pp/pool-client/testing"
import {
	createPublicClient,
	createTestClient,
	createWalletClient,
	type Hex,
	http,
	parseEther,
	type Transport,
	type WalletClient,
} from "viem"
import { foundry } from "viem/chains"
import { createL2Wallet, createNode } from "../../../../scripts/script-bootstrap"
import { deployAccountIfAbsent, sponsoredFpcFee } from "../../../../scripts/script-l2"
import { actorAccount, freshActorSecret } from "../../../../scripts/sandbox/l2"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../../../../src/artifacts"
import { openBridgeSession } from "../../../../src/client/session"
import { type AttachedStack, scratch } from "./stack"

const ARTIFACTS = { kind: "dir", path: circuitsDir() } as const
let nextIndex = 1_000 + Math.floor(Math.random() * 1_000_000) * 64

export const chainOf = (m: AttachedStack) => ({ ...foundry, rpcUrls: { default: { http: [m.l1Rpc] } } })

export function seedOf(m: AttachedStack): Seeder {
	const { poolVault, entrypoint, keystore, aspRegistry, deployBlock, asset, aspApiUrl } = m.pool
	return seeder({
		runId: "bridge-stack",
		rpcUrl: m.l1Rpc,
		chainId: m.chainId,
		deployment: { pool: poolVault, entrypoint, keystore, aspRegistry, deployBlock: String(deployBlock) },
		asset,
		aspUrl: aspApiUrl,
	})
}

/**
 * Moves L1 chain time forward by `seconds` and mines a block there. The stack's anvil ignores
 * `evm_increaseTime`; a pinned next-block timestamp holds.
 */
export async function advanceChainTime(m: AttachedStack, seconds: number): Promise<void> {
	const test = createTestClient({ chain: chainOf(m), transport: http(m.l1Rpc), mode: "anvil" })
	const { timestamp } = await createPublicClient({ transport: http(m.l1Rpc) }).getBlock()
	await test.setNextBlockTimestamp({ timestamp: timestamp + BigInt(seconds) })
	await test.mine({ blocks: 1 })
}

/** A fresh mnemonic index holding gas money. */
export async function fundedIndex(m: AttachedStack): Promise<number> {
	const index = nextIndex++
	const test = createTestClient({ chain: chainOf(m), transport: http(m.l1Rpc), mode: "anvil" })
	await test.setBalance({ address: anvilAccount(index).address, value: parseEther("10") })
	return index
}

export type Note = { label: bigint; commitment: bigint; value: bigint }
export type Owner = {
	address: Hex
	signature: Hex
	notes: Note[]
	register(): Promise<void>
	/** A further deposit, neither minted for nor approved. */
	deposit(value: bigint): Promise<{ label: bigint; commitment: bigint }>
}

/** A pool user holding one approved note per value; `registered: false` leaves its keystore unregistered and holds no notes. */
export async function owner(m: AttachedStack, seed: Seeder, values: readonly bigint[], o: { registered?: boolean } = {}): Promise<Owner> {
	const user = await seed.user(await fundedIndex(m))
	const notes: Note[] = []
	if (o.registered === false)
		return { address: user.address, signature: user.signature, notes, register: user.register, deposit: user.deposit }
	await seed.mint(
		user.address,
		values.reduce((a, b) => a + b, 0n),
	)
	await user.register()
	for (const value of values) {
		const { label, commitment } = await user.deposit(value)
		await seed.approveLabel(label)
		notes.push({ label, commitment, value })
	}
	return { address: user.address, signature: user.signature, notes, register: user.register, deposit: user.deposit }
}

export const sessionOf = (m: AttachedStack, o: Pick<Owner, "address" | "signature">) =>
	openBridgeSession({ manifest: m, l1Address: o.address, signature: o.signature, artifacts: ARTIFACTS })

/** An Ethereum sender that signs locally, over `transport` (plain HTTP by default). */
export async function sender(m: AttachedStack, transport?: Transport): Promise<WalletClient> {
	const account = anvilAccount(await fundedIndex(m))
	return createWalletClient({ account, chain: chainOf(m), transport: transport ?? http(m.l1Rpc) })
}

export type Device = {
	wallet: Awaited<ReturnType<typeof createL2Wallet>>
	node: AztecNode
	hub: AztecAddress
	token: AztecAddress
	stop(): Promise<void>
}

/** A device: an embedded wallet with its own store on disk, knowing the SponsoredFPC, the hub and its token. */
export async function device(m: AttachedStack, name: string, o: { knowsFpc?: boolean } = {}): Promise<Device> {
	const dir = scratch(name)
	const wallet = await createL2Wallet({ nodeUrl: m.aztecNode, proverEnabled: false, sandboxKeysOnly: true, dataDirectory: dir.path })
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
	return {
		wallet,
		node,
		hub,
		token,
		async stop() {
			try {
				await wallet.stop()
			} finally {
				dir.remove()
			}
		},
	}
}

export type Account = {
	address: AztecAddress
	secret: Hex
	completeAddress: CompleteAddress
	deploy(): Promise<void>
	/** Deploys the account and runs `payload` through its own entrypoint in the same transaction, paid as `payload` says. */
	deployWith(payload: ExecutionPayload): Promise<{ transactionFee?: bigint; blockNumber?: unknown }>
}

/** An account registered in `d`'s wallet and not deployed; `secret` re-creates it on another device. */
export async function account(d: Device, secret: Hex = freshActorSecret()): Promise<Account> {
	const { address, completeAddress, manager } = await actorAccount(d.wallet, secret)
	return {
		address,
		secret,
		completeAddress,
		async deploy() {
			const { fee } = await sponsoredFpcFee(d.wallet)
			await deployAccountIfAbsent({ node: d.node as never, manager: manager as never, from: address, fee, log: () => {} })
		},
		async deployWith(payload) {
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
			const method = await (
				manager as unknown as { getDeployMethod(): Promise<{ send(o: unknown): Promise<unknown> }> }
			).getDeployMethod()
			const sent = (await method.send({ from: NO_FROM, fee: { paymentMethod }, wait: { waitForStatus: TxStatus.PROPOSED } })) as {
				receipt: { transactionFee?: bigint; blockNumber?: unknown }
			}
			return sent.receipt
		},
	}
}

/** Sends `payload` from `from` as an app would: no fee option, so whatever pays is the payload's. */
export async function send(d: Device, from: AztecAddress, payload: ExecutionPayload) {
	const { receipt } = await d.wallet.sendTx(payload, { from, wait: { waitForStatus: TxStatus.PROPOSED } })
	return receipt
}

export const feeJuice = (d: Device, who: AztecAddress) => getFeeJuiceBalance(who, d.node)

/** `who`'s Fee Juice as of the end of L2 block `block`. */
export async function feeJuiceAt(d: Device, who: AztecAddress, block: number): Promise<bigint> {
	const slot = await deriveStorageSlotInMap(new Fr(1), who)
	return (await d.node.getPublicStorageAt(block as never, ProtocolContractAddress.FeeJuice, slot)).toBigInt()
}

/** The fees every transaction in L2 block `block` paid, in order. */
export async function blockFees(d: Device, block: number): Promise<bigint[]> {
	const b = await d.node.getBlock(block as never, { includeTransactions: true })
	if (!b) throw new Error(`the node has no block ${block}`)
	return b.body.txEffects.map((t) => t.transactionFee.toBigInt())
}

/** `holder`'s private balance under `label`, read through `d`'s own wallet. */
export async function labelBalance(d: Device, holder: AztecAddress, label: bigint): Promise<bigint> {
	const token = await Contract.at(d.token, labelledTokenArtifact, d.wallet as never)
	const r = (await token.methods.private_balances_by_label(holder, 0).simulate({ from: holder } as never)) as unknown
	const page = ((r as { result?: unknown }).result ?? r) as { storage?: unknown[]; len?: bigint | number } | unknown[]
	const rows = (Array.isArray(page) ? page : (page.storage ?? []).slice(0, Number(page.len ?? 0))) as [bigint, bigint, bigint][]
	return rows.filter(([l]) => BigInt(l) === label).reduce((sum, [, , v]) => sum + BigInt(v), 0n)
}
