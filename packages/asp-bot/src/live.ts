import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { aspRootRegistryArtifact } from "@pp/bridge-core/asp-registry-artifact"
import { actorAccount, createActor, FEE_CEILING } from "@pp/bridge-core/sandbox"
import { type Hex, readRootRecord } from "@pp/label-paths"
import { labelledTokenArtifact } from "@pp/labelled-token"
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseAbi } from "viem"
import { botSecret, localBotAccounts } from "./accounts"
import { fetchLeaves } from "./asp"
import { liveBirthSource } from "./births/live"
import { BirthReader } from "./births/reader"
import type { L1Block, PostArgs } from "./decide"
import type { BotConfig } from "./handle"
import { type BlockSource, type L1Tag, selectBlock } from "./l1"
import type { AztecTip, Ports } from "./loop"

const ASP_REGISTRY_ABI = parseAbi(["function latestASPRoot() view returns (uint256)", "error ASPRegistry_EmptyAssociationSet()"])

type Node = ReturnType<typeof createAztecNodeClient>
type BlockDataLike = { blockHash: { toString(): string }; header: { globalVariables: { timestamp: bigint } } }

/** A post once it is checkpointed. */
export type LivePost = { sequence: bigint; txHash: Hex; l2Block: number }

/** What the live adapters need, whichever entry builds them. */
export type LiveSpec = {
	l1Rpc: string
	aztecNode: string
	/** The L1 ASPRegistry whose `latestASPRoot` every posted pool root equals. */
	aspRegistry: Hex
	registry: Hex
	/** Labelled tokens whose births the intake approves; none keeps the birth root 0. */
	tokens: readonly Hex[]
	tag: L1Tag
	/** The wallet's PXE store, which the caller owns and removes. */
	store: string
	proverEnabled: boolean
	/** "node" leaves gas to the node's estimate; "ceiling" pays up to the sandbox's `FEE_CEILING`. */
	gas: "ceiling" | "node"
	postTimeoutSec: number
	/** The intake's secret is read only when `tokens` is non-empty. */
	secrets: { poster: Hex; intake?: Hex }
	aspLeaves(): Promise<bigint[]>
	onPosted?(p: LivePost): void
	/** Refuse, before the poster's account deploys, unless the registry names the derived poster and intake. */
	checkRoles?: true
	/** Checked before the account deploy, the start's only write. */
	signal?: AbortSignal
}

export type Live = {
	ports: Ports
	self: bigint
	poster: Hex
	/** Derived only when the spec has tokens. */
	birthIntake?: Hex
	/** The registry's `poster` or `birth_intake` at Aztec block hash `at`, as a field. */
	role(name: "poster" | "birth_intake", at: Hex): Promise<bigint>
	blockNumber(): Promise<number>
	/** Stops the wallet; the caller then removes `store`. */
	stop(): Promise<void>
}

function l1Source(rpc: string) {
	const client = createPublicClient({ transport: http(rpc) })
	const header = (b: { number: bigint | null; hash: Hex | null; timestamp: bigint }): L1Block => ({
		number: b.number ?? 0n,
		hash: b.hash ?? "0x",
		timestamp: b.timestamp,
	})
	const blocks: BlockSource = {
		head: async (tag) => header(await client.getBlock({ blockTag: tag })),
		at: async (number) => header(await client.getBlock({ blockNumber: number })),
	}
	return { client, blocks }
}

async function blockAt(node: Node, number: number): Promise<{ hash: Hex; time: bigint }> {
	const data = (await node.getBlockData(number as never)) as BlockDataLike | undefined
	if (!data) throw new Error(`node: no block ${number}`)
	return { hash: data.blockHash.toString() as Hex, time: data.header.globalVariables.timestamp }
}

class BotWallet extends EmbeddedWallet {
	/** Syncs the PXE and returns the block it reads at; a query sent after this reads at that block or above. */
	async syncedBlock(): Promise<number> {
		await this.pxe.sync()
		return Number((await this.pxe.getSyncedBlockHeader()).getBlockNumber())
	}
}

async function walletFor(s: LiveSpec, node: Node) {
	const wallet = await BotWallet.create(s.aztecNode, {
		pxeConfig: { proverEnabled: s.proverEnabled, dataDirectory: s.store },
	})
	try {
		const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
		await wallet.registerContract(fpc, SponsoredFPCContract.artifact).catch(() => {})
		const paymentMethod = new SponsoredFeePaymentMethod(fpc.address)
		const fee = s.gas === "ceiling" ? { paymentMethod, gasSettings: FEE_CEILING } : { paymentMethod }
		const registry = AztecAddress.fromStringUnsafe(s.registry)
		const instance = await node.getContract(registry)
		if (!instance) throw new Error(`node: no registry at ${s.registry}`)
		await wallet.registerContract(instance, aspRootRegistryArtifact).catch(() => {})
		return { wallet, fee, registry: await Contract.at(registry, aspRootRegistryArtifact, wallet) }
	} catch (e) {
		await wallet.stop().catch(() => {})
		throw e
	}
}

/** The intake's account is registered locally and never deployed: decrypting needs only its keys. */
async function birthLeavesFor(
	s: LiveSpec,
	wallet: BotWallet,
	node: Node,
	log: Ports["log"],
): Promise<{ birthLeaves: Ports["birthLeaves"]; intake?: Hex }> {
	const tokens = s.tokens.map((t) => AztecAddress.fromStringUnsafe(t))
	if (tokens.length === 0) return { birthLeaves: async () => [] }
	if (!s.secrets.intake) throw new Error("approving births needs the intake's secret")
	const { address: intake } = await actorAccount(wallet, s.secrets.intake)
	const { id: classId } = await getContractClassFromArtifact(labelledTokenArtifact)
	for (const token of tokens) {
		const instance = await node.getContract(token)
		if (!instance) throw new Error(`node: no token at ${token}`)
		// The PXE registers a mismatched artifact silently and fails later on every sync. The original
		// class counts too: the scan reads the token's whole history, events from before an upgrade included.
		const { currentContractClassId: now, originalContractClassId: first } = instance
		if (!now.equals(classId) || !first.equals(classId))
			throw new Error(`token ${token} runs class ${now} (deployed as ${first}), not the labelled token's ${classId}`)
		await wallet.registerContract(instance, labelledTokenArtifact)
	}
	const src = await liveBirthSource({
		wallet,
		node: node as never,
		intake,
		artifact: labelledTokenArtifact,
		syncedBlock: () => wallet.syncedBlock(),
		blockHash: async (n) => (await blockAt(node, n)).hash,
	})
	const reader = new BirthReader(src, tokens, log)
	return { birthLeaves: (tip) => reader.leaves(tip), intake: intake.toString() as Hex }
}

/** `latestASPRoot()` at `e`'s hash: a reorg after selection must fail the read, not pair `e`'s time with another block's root. */
async function aspRootAt(l1: ReturnType<typeof l1Source>, aspRegistry: Hex, e: L1Block): Promise<bigint | null> {
	try {
		return await l1.client.readContract({
			address: aspRegistry,
			abi: ASP_REGISTRY_ABI,
			functionName: "latestASPRoot",
			blockHash: e.hash,
			requireCanonical: true,
		})
	} catch (err) {
		const revert = err instanceof BaseError ? err.walk((x) => x instanceof ContractFunctionRevertedError) : null
		if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "ASPRegistry_EmptyAssociationSet") return null
		throw err
	}
}

/** Refuses a start whose derived accounts are not the registry's roles at the checkpointed tip: every tick would halt. */
async function assertRoles(role: Live["role"], node: Node, poster: bigint, intake: Hex | undefined): Promise<void> {
	const { hash } = await blockAt(node, Number(await node.getBlockNumber("checkpointed")))
	if ((await role("poster", hash)) !== poster) throw new Error(`the registry's poster is not 0x${poster.toString(16)}`)
	if (intake && (await role("birth_intake", hash)) !== BigInt(intake)) throw new Error(`the registry's birth intake is not ${intake}`)
}

/** The live adapters over `s`; a failed start stops the wallet it created. */
export async function liveFrom(s: LiveSpec, log: Ports["log"]): Promise<Live> {
	const node = createAztecNodeClient(s.aztecNode)
	const { wallet, fee, registry } = await walletFor(s, node)
	try {
		const births = await birthLeavesFor(s, wallet, node, log)
		const slots = aspRootRegistryArtifact.storageLayout
		const role = async (name: "poster" | "birth_intake", at: Hex) =>
			(await node.getPublicStorageAt({ hash: at } as never, registry.address, new Fr(slots[name]?.slot ?? Fr.ZERO))).toBigInt()
		if (s.checkRoles) await assertRoles(role, node, (await actorAccount(wallet, s.secrets.poster)).address.toBigInt(), births.intake)
		s.signal?.throwIfAborted()
		const actor = await createActor(wallet, node as never, fee, s.secrets.poster, undefined, (l) => log("account", { line: l }))
		const l1 = l1Source(s.l1Rpc)
		const send = { from: actor.address, fee, wait: { waitForStatus: TxStatus.CHECKPOINTED, timeout: s.postTimeoutSec } }
		const ports: Ports = {
			async tip(): Promise<AztecTip> {
				const number = Number(await node.getBlockNumber("checkpointed"))
				return { number, ...(await blockAt(node, number)) }
			},
			record: (at) => readRootRecord({ aztecNode: s.aztecNode, registry: s.registry, at }),
			poster: (at) => role("poster", at),
			selectL1: (aztecTime) => selectBlock(l1.blocks, s.tag, aztecTime),
			aspRootAt: (e) => aspRootAt(l1, s.aspRegistry, e),
			aspLeaves: s.aspLeaves,
			birthLeaves: births.birthLeaves,
			async post(a: PostArgs) {
				const call = registry.methods.post_root(a.sequence, new Fr(a.poolRoot), new Fr(a.birthRoot), a.l1Block, a.rootTime)
				const { receipt } = (await call.send(send as never)) as unknown as {
					receipt: { blockNumber?: number; txHash: { toString(): string } }
				}
				if (receipt.blockNumber === undefined) throw new Error("post_root: no block in its receipt")
				const l2Block = Number(receipt.blockNumber)
				s.onPosted?.({ sequence: a.sequence, txHash: receipt.txHash.toString() as Hex, l2Block })
				return { inclusionTime: (await blockAt(node, l2Block)).time }
			},
			log,
		}
		return {
			ports,
			self: actor.address.toBigInt(),
			poster: actor.address.toString() as Hex,
			...(births.intake ? { birthIntake: births.intake } : {}),
			role,
			blockNumber: async () => Number(await node.getBlockNumber()),
			stop: () => wallet.stop(),
		}
	} catch (e) {
		await wallet.stop().catch(() => {})
		throw e
	}
}

/** The child's adapters: secrets bound to the stack, a store under `dataDir`, proving off, the sandbox fee ceiling. */
export async function livePorts(c: BotConfig, log: Ports["log"]): Promise<Live & { birthIntake: Hex }> {
	const expected = await localBotAccounts(c.stackRunId)
	const live = await liveFrom(
		{
			l1Rpc: c.manifest.l1Rpc,
			aztecNode: c.manifest.aztecNode,
			aspRegistry: c.manifest.pool.aspRegistry,
			registry: c.registry,
			tokens: c.tokens ?? [],
			tag: c.tag,
			store: join(c.dataDir as string, "pxe"),
			proverEnabled: false,
			gas: "ceiling",
			postTimeoutSec: 120,
			secrets: { poster: botSecret("poster", c.stackRunId), intake: botSecret("intake", c.stackRunId) },
			aspLeaves: () => fetchLeaves(c.manifest.pool.aspApiUrl),
		},
		log,
	)
	if (live.poster !== expected.poster) throw new Error(`poster derivation mismatch: ${live.poster} != ${expected.poster}`)
	if (live.birthIntake !== undefined && live.birthIntake !== expected.birthIntake)
		throw new Error(`intake derivation mismatch: ${live.birthIntake} != ${expected.birthIntake}`)
	return { ...live, birthIntake: expected.birthIntake }
}
