/**
 * Actors on a running local stack, for its scripts and its test suite: pool owners, Ethereum senders
 * and Aztec devices. Owners and senders sign from mnemonic indices far above the stack's own (0 for
 * the node's publisher, 12 to 15 for the demo, pp-env and the bridge deployer), funded here and drawn
 * afresh per process, so a re-run on a kept stack never meets a registered owner or a used nonce.
 * Local stack only: funding goes through anvil's own methods.
 */
import type { CompleteAddress } from "@aztec-labs/aztec.js/addresses"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { type ExecutionPayload, TxStatus } from "@aztec-labs/stdlib/tx"
import { anvilAccount, circuitsDir, type Seeder, seeder } from "@pp/pool-client/testing"
import { createTestClient, createWalletClient, type Hex, http, parseEther, type Transport, type WalletClient } from "viem"
import { foundry } from "viem/chains"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../src/artifacts"
import type { KeyValueStore } from "../src/client/journal"
import { openBridgeSession } from "../src/client/session"
import type { requireBlocks } from "../src/stack-manifest"
import { actorAccount, freshActorSecret } from "./sandbox/l2"
import { createL2Wallet, createNode } from "./script-bootstrap"
import { deployAccountIfAbsent, sponsoredFpcFee } from "./script-l2"

/** A stack manifest that carries a bridge. */
export type BridgeStack = ReturnType<typeof requireBlocks<"bridge">>

const ARTIFACTS = { kind: "dir", path: circuitsDir() } as const
let nextIndex = 1_000 + Math.floor(Math.random() * 1_000_000) * 64

export const chainOf = (m: BridgeStack) => ({ ...foundry, rpcUrls: { default: { http: [m.l1Rpc] } } })

export function seedOf(m: BridgeStack): Seeder {
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

/** A fresh mnemonic index holding gas money. */
export async function fundedIndex(m: BridgeStack): Promise<number> {
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
export async function owner(m: BridgeStack, seed: Seeder, values: readonly bigint[], o: { registered?: boolean } = {}): Promise<Owner> {
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

export const sessionOf = (m: BridgeStack, o: Pick<Owner, "address" | "signature">) =>
	openBridgeSession({ manifest: m, l1Address: o.address, signature: o.signature, artifacts: ARTIFACTS })

/** An Ethereum sender that signs locally, over `transport` (plain HTTP by default). */
export async function sender(m: BridgeStack, transport?: Transport): Promise<WalletClient> {
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

/**
 * A device: an embedded wallet that knows the SponsoredFPC (unless `knowsFpc` is false), the hub and
 * its token. Its store is `dataDirectory` when given, else one this process owns and removes.
 */
export async function device(m: BridgeStack, o: { dataDirectory?: string; knowsFpc?: boolean } = {}): Promise<Device> {
	const wallet = await createL2Wallet({
		nodeUrl: m.aztecNode,
		proverEnabled: false,
		sandboxKeysOnly: true,
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

/** A journal that lives as long as the process: a script that bridges once needs no other. */
export const memoryJournal = (): KeyValueStore => {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}
