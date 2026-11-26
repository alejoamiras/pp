/** The hub suite's world on one owned local network:
 *  - a deployer that publishes the token class, deploys the hub and registers one token;
 *  - two anvil accounts that stand in for the factory and the portal on the Inbox and the Outbox, so
 *    no portal contract or pool is needed;
 *  - one wallet per holder.
 *  Blocks come from the transactions under test and from `beat`, the node's debug mine, never from
 *  filler transactions. */
import { InboxAbi } from "@aztec-foundation/l1-artifacts/InboxAbi"
import { OutboxAbi } from "@aztec-foundation/l1-artifacts/OutboxAbi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractBase } from "@aztec-labs/aztec.js/contracts"
import { publishContractClass } from "@aztec-labs/aztec.js/deployment"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { OutboxContract } from "@aztec-labs/ethereum/contracts"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { computeL2ToL1MembershipWitness } from "@aztec-labs/stdlib/messaging"
import { bridgeContentV1, changeCommitment, claimSecretHash } from "@pp/bridge-spec"
import { type Address, type Hex, parseEventLogs } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../../../src/artifacts"
import type { L1Ctx } from "../../../src/flows"
import { deriveHubTokenInstance } from "../../../src/hub-token"
import { l1ToL2MessageReadiness } from "../../../src/l1-to-l2-readiness"
import { registerContentHash, registerSecretHash, toWord, utf8 } from "../../../src/register-hash"
import { createL1Clients, createL2Wallet } from "../../../scripts/script-bootstrap"
import { deriveInstance, sponsoredFpcFee } from "../../../scripts/script-l2"
import { anvilKey, FEE_CEILING, sandboxChain } from "../../../scripts/sandbox/constants"
import { connectL2, createActor, freshActorSecret, type L2Base } from "../../../scripts/sandbox/l2"

/** Below the harness's own index and away from index 0, which the node's publisher signs from. */
const FACTORY_INDEX = 13
const PORTAL_INDEX = 14
const ERC20 = "0x00000000000000000000000000000000000e2c20" as Address
const WORDS = { nameWord: toWord(utf8("Hub Suite Dollar")), symbolWord: toWord(utf8("HSD")), decimals: 6 }

export interface World {
	nodeUrl: string
	base: L2Base
	factory: L1Ctx
	portal: L1Ctx
	inbox: Address
	outbox: Address
	rollupVersion: bigint
	l1ChainId: number
	hub: AztecAddress
	token: AztecAddress
}

export interface Holder {
	wallet: Wallet
	address: AztecAddress
	hub: ContractBase
	token: ContractBase
	opts: Record<string, unknown>
}

export interface Deposit {
	amount: bigint
	nullifier: bigint
	precommitment: bigint
	label: bigint
	claimSalt: bigint
}

/** The node's debug mine: one block with no transaction, the heartbeat's beat. */
export async function beat(nodeUrl: string): Promise<void> {
	const res = await fetch(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "aztecDebug_mineBlock", params: [] }),
	})
	const body = (await res.json()) as { error?: { message: string } }
	if (body.error) throw new Error(`aztecDebug_mineBlock: ${body.error.message}`)
}

function l1At(anvilUrl: string, index: number): L1Ctx {
	const account = privateKeyToAccount(anvilKey(index))
	return { ...createL1Clients({ chain: sandboxChain(anvilUrl), rpcUrl: anvilUrl, account }), account } as unknown as L1Ctx
}

async function teach(wallet: Wallet, instance: Parameters<Wallet["registerContract"]>[0], artifact: typeof labelledTokenArtifact) {
	await wallet.registerContract(instance, artifact)
}

/** Sends an L1→L2 message from `l1` to the hub and returns its leaf hash and global index. */
export async function sendToHub(world: World, l1: L1Ctx, content: bigint | string, secretHash: bigint | string) {
	const hash = await l1.wallet.writeContract({
		address: world.inbox,
		abi: InboxAbi,
		functionName: "sendL2Message",
		args: [{ actor: world.hub.toString() as Hex, version: world.rollupVersion }, toBytes32(content), toBytes32(secretHash)],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	const [sent] = parseEventLogs({ abi: InboxAbi, eventName: "MessageSent", logs: receipt.logs })
	if (!sent) throw new Error("the Inbox emitted no MessageSent")
	return { leaf: sent.args.hash as Hex, index: sent.args.message.index }
}

const toBytes32 = (v: bigint | string): Hex => `0x${BigInt(v).toString(16).padStart(64, "0")}` as Hex

/**
 * Waits until the node has indexed the message, then beats until a claim can consume it and returns
 * how many beats that took. The heartbeat grants two after an Ethereum transaction the node did
 * not send; `maxBeats` is that grant.
 */
export async function untilConsumable(world: World, leaf: string, maxBeats = 2): Promise<number> {
	const node = world.base.node as never
	for (const end = Date.now() + 60_000; (await l1ToL2MessageReadiness(node, leaf)) === null; ) {
		if (Date.now() > end) throw new Error(`the node never indexed L1→L2 message ${leaf}`)
		await new Promise((r) => setTimeout(r, 500))
	}
	for (let beats = 0; beats <= maxBeats; beats++) {
		const r = await l1ToL2MessageReadiness(node, leaf)
		if (r && r.anchor >= r.checkpoint) return beats
		if (beats < maxBeats) await beat(world.nodeUrl)
	}
	throw new Error(`L1→L2 message ${leaf} was not consumable after ${maxBeats} beats`)
}

async function publishClass(base: L2Base, artifact: typeof labelledTokenArtifact): Promise<void> {
	const { id } = await getContractClassFromArtifact(artifact)
	if (await base.node.getContractClass(id)) return
	const interaction = await publishContractClass(base.wallet, artifact)
	await interaction.send(deployOpts(base) as never)
}

const deployOpts = (base: L2Base) => ({ ...base.relayerOpts, wait: { waitForStatus: TxStatus.CHECKPOINTED } })

/** Deploys a hub with no registry and registers one token through a factory-sent message. */
export async function bootWorld(net: { anvilUrl: string; nodeUrl: string }): Promise<World> {
	const base = await connectL2(net.nodeUrl)
	const info = await base.node.getNodeInfo()
	const factory = l1At(net.anvilUrl, FACTORY_INDEX)
	const portal = l1At(net.anvilUrl, PORTAL_INDEX)
	await publishClass(base, labelledTokenArtifact)
	const { id: tokenClassId } = await getContractClassFromArtifact(labelledTokenArtifact)
	const args = [tokenClassId, EthAddress.fromString(factory.account.address), AztecAddress.ZERO]
	const salt = Fr.random()
	const hubInstance = await deriveInstance(tokenBridgeHubArtifact, args, "constructor", salt, AztecAddress.ZERO)
	await Contract.deploy(base.wallet, tokenBridgeHubArtifact, args, "constructor", { salt, universalDeploy: true } as never).send(
		deployOpts(base) as never,
	)
	const world: World = {
		nodeUrl: net.nodeUrl,
		base,
		factory,
		portal,
		inbox: info.l1ContractAddresses.inboxAddress.toString() as Address,
		outbox: info.l1ContractAddresses.outboxAddress.toString() as Address,
		rollupVersion: BigInt(info.rollupVersion),
		l1ChainId: info.l1ChainId,
		hub: hubInstance.address,
		token: AztecAddress.ZERO,
	}
	world.token = await registerToken(world, tokenClassId.toString())
	return world
}

async function registerToken(world: World, tokenClassId: string): Promise<AztecAddress> {
	const content = await registerContentHash(ERC20, world.portal.account.address, WORDS.nameWord, WORDS.symbolWord, WORDS.decimals)
	const { leaf, index } = await sendToHub(world, world.factory, content, (await registerSecretHash()).toBigInt())
	await untilConsumable(world, leaf)
	// The wallet simulates the token's enqueued constructor, so it must know the instance first.
	const instance = await deriveHubTokenInstance(world.hub, ERC20, WORDS, tokenClassId, AztecAddress.ZERO)
	await teach(world.base.wallet, instance, labelledTokenArtifact)
	const hub = await Contract.at(world.hub, tokenBridgeHubArtifact, world.base.wallet)
	await hub.methods
		.register_token(
			EthAddress.fromString(ERC20),
			EthAddress.fromString(world.portal.account.address),
			Fr.fromHexString(WORDS.nameWord),
			Fr.fromHexString(WORDS.symbolWord),
			WORDS.decimals,
			new Fr(index),
		)
		.send(deployOpts(world.base) as never)
	return instance.address
}

/** A fresh account in a wallet of its own, which knows the hub and the token. */
export async function newHolder(world: World): Promise<Holder> {
	const wallet = await createL2Wallet({ nodeUrl: world.nodeUrl, proverEnabled: false, sandboxKeysOnly: true })
	const { fee } = await sponsoredFpcFee(wallet)
	const paid = { ...fee, gasSettings: FEE_CEILING }
	const actor = await createActor(wallet, world.base.node, paid, freshActorSecret(), 1n, () => {})
	const hubInstance = await world.base.node.getContract(world.hub)
	const tokenInstance = await world.base.node.getContract(world.token)
	if (!hubInstance || !tokenInstance) throw new Error("the node does not serve the hub or its token")
	await teach(wallet as unknown as Wallet, hubInstance as never, tokenBridgeHubArtifact)
	await teach(wallet as unknown as Wallet, tokenInstance as never, labelledTokenArtifact)
	return {
		wallet: wallet as unknown as Wallet,
		address: actor.address,
		hub: await Contract.at(world.hub, tokenBridgeHubArtifact, wallet as unknown as Wallet),
		token: await Contract.at(world.token, labelledTokenArtifact, wallet as unknown as Wallet),
		opts: { from: actor.address, fee: paid, wait: { waitForStatus: TxStatus.CHECKPOINTED } },
	}
}

/** The portal's bridge message for `d`, its secret bound to `recipient`. */
export async function sendDeposit(world: World, recipient: AztecAddress, d: Deposit) {
	const content = bridgeContentV1({
		nullifier: d.nullifier,
		changeCommitment: changeCommitment(d.precommitment, d.label),
		amount: d.amount,
	})
	return sendToHub(world, world.portal, content, await claimSecretHash(d.claimSalt, recipient))
}

export function claim(h: Holder, world: World, d: Deposit, index: bigint) {
	return h.hub.methods
		.claim_from_pool(
			world.token,
			d.amount,
			new Fr(d.nullifier),
			new Fr(d.precommitment),
			new Fr(d.label),
			new Fr(d.claimSalt),
			new Fr(index),
		)
		.send(h.opts as never) as Promise<{ receipt: { txHash: { toString(): string } } }>
}

/** `owner`'s private balance of one label, read through the holder's own wallet. */
export async function labelBalance(h: Holder, label: bigint): Promise<bigint> {
	const r = (await h.token.methods.private_balances_by_label(h.address, 0).simulate({ from: h.address } as never)) as unknown
	const page = ((r as { result?: unknown }).result ?? r) as { storage?: unknown[]; len?: bigint | number } | unknown[]
	const rows = (Array.isArray(page) ? page : (page.storage ?? []).slice(0, Number(page.len ?? 0))) as [bigint, bigint, bigint][]
	return rows.filter(([l]) => BigInt(l) === label).reduce((sum, [, , v]) => sum + BigInt(v), 0n)
}

export interface OutboxAcceptance {
	depth: number
	epoch: bigint
	numCheckpointsInEpoch: bigint
	leafIndex: bigint
	path: Hex[]
}

/**
 * Whether the Outbox already holds a root under which `messageHash` is provable. The local network
 * settles each checkpoint as it lands, partial epochs included, so a message can be accepted at
 * its own checkpoint (depth 0).
 */
async function accepted(world: World, messageHash: Fr, txHash: unknown): Promise<Omit<OutboxAcceptance, "depth"> | undefined> {
	const outbox = new OutboxContract(world.portal.pub as never, world.outbox)
	const wit = await computeL2ToL1MembershipWitness(world.base.node as never, outbox, messageHash, txHash as never, 0).catch(
		() => undefined,
	)
	if (!wit) return undefined
	const root = (await world.portal.pub.readContract({
		address: world.outbox,
		abi: OutboxAbi,
		functionName: "getRootData",
		args: [BigInt(wit.epochNumber), BigInt(wit.numCheckpointsInEpoch)],
	})) as Hex
	if (BigInt(root) === 0n) return undefined
	return {
		epoch: BigInt(wit.epochNumber),
		numCheckpointsInEpoch: BigInt(wit.numCheckpointsInEpoch),
		leafIndex: wit.leafIndex,
		path: wit.siblingPath.toBufferArray().map((b: Buffer) => `0x${b.toString("hex")}` as Hex),
	}
}

async function pollAccepted(world: World, messageHash: Fr, txHash: unknown, ms: number) {
	for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 500))) {
		const a = await accepted(world, messageHash, txHash)
		if (a || Date.now() > end) return a
	}
}

/** Polls at the transaction's own height, then after the single beat the heartbeat grants a quiet
 *  stack after an Aztec block it did not mine. No acceptance by then fails. */
export async function untilOutboxAccepts(world: World, messageHash: Fr, txHash: unknown): Promise<OutboxAcceptance> {
	const atZero = await pollAccepted(world, messageHash, txHash, 30_000)
	if (atZero) return { depth: 0, ...atZero }
	await beat(world.nodeUrl)
	const atOne = await pollAccepted(world, messageHash, txHash, 30_000)
	if (atOne) return { depth: 1, ...atOne }
	throw new Error("the Outbox did not accept the exit within one beat: the heartbeat alone would never settle it")
}

/** The portal's own consume of the exit message on Ethereum. */
export async function consumeAsPortal(world: World, content: bigint, a: OutboxAcceptance) {
	const message = {
		sender: { actor: world.hub.toString() as Hex, version: world.rollupVersion },
		recipient: { actor: world.portal.account.address, chainId: BigInt(world.l1ChainId) },
		content: toBytes32(content),
	}
	const hash = await world.portal.wallet.writeContract({
		address: world.outbox,
		abi: OutboxAbi,
		functionName: "consume",
		args: [message, a.epoch, a.numCheckpointsInEpoch, a.leafIndex, a.path],
		account: world.portal.account,
		chain: world.portal.wallet.chain,
	} as never)
	return world.portal.pub.waitForTransactionReceipt({ hash })
}
