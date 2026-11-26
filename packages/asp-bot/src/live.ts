import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { aspRootRegistryArtifact } from "@pp/bridge-core/asp-registry-artifact"
import { createActor, FEE_CEILING } from "@pp/bridge-core/sandbox"
import { type Hex, readRootRecord } from "@pp/label-paths"
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseAbi } from "viem"
import { botSecret, localBotAccounts } from "./accounts"
import { fetchLeaves } from "./asp"
import type { L1Block, PostArgs } from "./decide"
import type { BotConfig } from "./handle"
import { type BlockSource, selectBlock } from "./l1"
import type { AztecTip, Ports } from "./loop"

const ASP_REGISTRY_ABI = parseAbi(["function latestASPRoot() view returns (uint256)", "error ASPRegistry_EmptyAssociationSet()"])

type Node = ReturnType<typeof createAztecNodeClient>
type BlockDataLike = { blockHash: { toString(): string }; header: { globalVariables: { timestamp: bigint } } }

export type Live = { ports: Ports; self: bigint; poster: Hex; birthIntake: Hex; blockNumber(): Promise<number> }

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

/** The bot's wallet: its own store under `dataDir`, proving off on the local network. */
async function walletFor(c: BotConfig, node: Node) {
	const wallet = await EmbeddedWallet.create(c.manifest.aztecNode, {
		pxeConfig: { proverEnabled: false, dataDirectory: join(c.dataDir as string, "pxe") },
	})
	const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
	await wallet.registerContract(fpc, SponsoredFPCContract.artifact).catch(() => {})
	const fee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address), gasSettings: FEE_CEILING }
	const registry = AztecAddress.fromStringUnsafe(c.registry)
	const instance = await node.getContract(registry)
	if (!instance) throw new Error(`node: no registry at ${c.registry}`)
	await wallet.registerContract(instance, aspRootRegistryArtifact).catch(() => {})
	return { wallet, fee, registry: await Contract.at(registry, aspRootRegistryArtifact, wallet) }
}

/** The live ports: viem for Ethereum, the Aztec node and the bot's embedded wallet, the ASP's HTTP API. */
export async function livePorts(c: BotConfig, log: Ports["log"]): Promise<Live> {
	const node = createAztecNodeClient(c.manifest.aztecNode)
	const { wallet, fee, registry } = await walletFor(c, node)
	const actor = await createActor(wallet, node as never, fee, botSecret("poster", c.stackRunId), undefined, (l) =>
		log("account", { line: l }),
	)
	const { poster, birthIntake } = await localBotAccounts(c.stackRunId)
	if (actor.address.toString() !== poster) throw new Error(`poster derivation mismatch: ${actor.address} != ${poster}`)
	const posterSlot = new Fr(aspRootRegistryArtifact.storageLayout.poster?.slot ?? Fr.ZERO)
	const l1 = l1Source(c.manifest.l1Rpc)
	const send = { from: actor.address, fee, wait: { waitForStatus: TxStatus.CHECKPOINTED, timeout: 120 } }

	const ports: Ports = {
		async tip(): Promise<AztecTip> {
			const number = Number(await node.getBlockNumber("checkpointed"))
			return { number, ...(await blockAt(node, number)) }
		},
		record: (at) => readRootRecord({ aztecNode: c.manifest.aztecNode, registry: c.registry, at }),
		poster: async (at) => (await node.getPublicStorageAt({ hash: at } as never, registry.address, posterSlot)).toBigInt(),
		selectL1: (aztecTime) => selectBlock(l1.blocks, c.tag, aztecTime),
		async aspRootAt(e) {
			try {
				return await l1.client.readContract({
					address: c.manifest.pool.aspRegistry,
					abi: ASP_REGISTRY_ABI,
					functionName: "latestASPRoot",
					blockNumber: e.number,
				})
			} catch (err) {
				const revert = err instanceof BaseError ? err.walk((x) => x instanceof ContractFunctionRevertedError) : null
				if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "ASPRegistry_EmptyAssociationSet")
					return null
				throw err
			}
		},
		aspLeaves: () => fetchLeaves(c.manifest.pool.aspApiUrl),
		birthLeaves: async () => [],
		async post(a: PostArgs) {
			const call = registry.methods.post_root(a.sequence, new Fr(a.poolRoot), new Fr(a.birthRoot), a.l1Block, a.rootTime)
			const { receipt } = (await call.send(send as never)) as unknown as { receipt: { blockNumber?: number } }
			if (receipt.blockNumber === undefined) throw new Error("post_root: no block in its receipt")
			return { inclusionTime: (await blockAt(node, Number(receipt.blockNumber))).time }
		},
		log,
	}
	return { ports, self: actor.address.toBigInt(), poster, birthIntake, blockNumber: async () => Number(await node.getBlockNumber()) }
}
