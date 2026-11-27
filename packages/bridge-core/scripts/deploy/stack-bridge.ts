/**
 * A local stack's bridge: one generation on a running local network, deployed with entries paused,
 * and opened only once every binding reads back as expected. Node only; the orchestrator's, never a
 * client's. It composes the generation deploy and adds only the registry input and the opening.
 */
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractBase } from "@aztec-labs/aztec.js/contracts"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { type Address, defineChain, type Hex, isAddressEqual } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { tokenBridgeHubArtifact } from "../../src/artifacts"
import { aspRootRegistryArtifact } from "../../src/asp-registry-artifact"
import { PORTAL_FACTORY_ABI } from "../../src/factory-abi"
import type { L1Ctx } from "../../src/flows"
import { assertGenerationBindings, type ExpectedBindings, rollupEndpointsOf } from "../../src/generation-bindings"
import { hubTokenFor } from "../../src/hub-l2"
import type { StackManifest } from "../../src/stack-manifest"
import { openDeployJournal } from "../deploy-manifest"
import { type AztecNode, deployGeneration, type GenerationRecord, type L2Ctx, NO_ASP_REGISTRY, preCreateToken } from "../generation"
import { FEE_CEILING } from "../sandbox/constants"
import { createActor, SANDBOX_ACTOR_SALT, SANDBOX_ACTOR_SECRET } from "../sandbox/l2"
import { createL1Clients, createL2Wallet, createNode } from "../script-bootstrap"
import { missingEvmArtifacts } from "../script-artifacts"
import { registerHub, sponsoredFpcFee } from "../script-l2"
import { assertV1Hub } from "./v1-hub"

export type StackBridgeBlock = NonNullable<StackManifest["bridge"]>

/** The L1 contracts a generation deploys from `forge build` output; the factory creates the implementation itself. */
const DEPLOYED_FROM_FORGE = ["PortalFactory"] as const

/** The forge artifacts a deploy needs that are not built yet, as paths: empty when it can run. */
export const missingDeployArtifacts = (): string[] => missingEvmArtifacts(DEPLOYED_FROM_FORGE)

export type DeployBridgeOptions = {
	l1Rpc: string
	aztecNode: string
	chainId: number
	pool: { poolVault: Address; asset: Address }
	/** Owner and guardian of the factory: a sandbox key, never a real one. */
	deployerKey: Hex
	lifetimeCap: bigint
	/** The ASP registry's operators; absent, the hub and its token get the zero registry. */
	registry?: { poster: Hex; birthIntake: Hex }
	/** Only an orchestrator passes this, before its heartbeat runs; absent, blocks come from beats. */
	forceBlock?: () => Promise<void>
	/** The deployer's PXE store and the deploy journal; the caller owns and removes it. */
	dataDir: string
}

/** A deployed generation whose entries are still paused. */
export interface UnopenedBridge {
	readonly block: StackBridgeBlock
	readonly expected: ExpectedBindings
	/** Stops the deployer's PXE. Idempotent. */
	stop(): Promise<void>
	/** True once `stop()` has been called. */
	readonly stopped: boolean
}

type Internals = {
	l1: L1Ctx
	wallet: Wallet
	node: AztecNode
	from: AztecAddress
	gen: GenerationRecord
	asset: Address
	registry?: ContractBase
}

const internals = new WeakMap<UnopenedBridge, Internals>()

const lc = (a: string) => a.toLowerCase() as Hex

function l1For(o: DeployBridgeOptions): L1Ctx {
	const chain = defineChain({
		id: o.chainId,
		name: "stack",
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [o.l1Rpc] } },
	})
	const account = privateKeyToAccount(o.deployerKey)
	return { ...createL1Clients({ chain, rpcUrl: o.l1Rpc, account }), account } as unknown as L1Ctx
}

async function l2For(o: DeployBridgeOptions, wallet: Wallet, node: AztecNode): Promise<L2Ctx> {
	const { fee: sponsored } = await sponsoredFpcFee(wallet)
	const fee = { ...sponsored, gasSettings: FEE_CEILING }
	const actor = await createActor(wallet, node, fee, SANDBOX_ACTOR_SECRET, SANDBOX_ACTOR_SALT, (line) => console.log(`[bridge] ${line}`))
	const from = actor.address
	return {
		wallet,
		node,
		from,
		deployOpts: { from, fee, wait: { waitForStatus: TxStatus.CHECKPOINTED } } as never,
		sendOpts: { from, fee, wait: { waitForStatus: TxStatus.PROPOSED } } as never,
		...(o.forceBlock ? { forceBlock: o.forceBlock } : {}),
	}
}

/** The deployer is the registry's admin; poster and intake come from the caller (the bot's accounts). */
async function deployRegistry(l2: L2Ctx, r: NonNullable<DeployBridgeOptions["registry"]>): Promise<ContractBase> {
	const args = [l2.from, AztecAddress.fromStringUnsafe(r.poster), AztecAddress.fromStringUnsafe(r.birthIntake)]
	const sent = await Contract.deploy(l2.wallet, aspRootRegistryArtifact, args).send(l2.deployOpts as never)
	return (sent as unknown as { contract: ContractBase }).contract
}

type Deployed = { gen: GenerationRecord; block: StackBridgeBlock; registry?: ContractBase }

async function deployOnto(o: DeployBridgeOptions, l1: L1Ctx, l2: L2Ctx): Promise<Deployed> {
	const info = await l2.node.getNodeInfo()
	const registryL1 = lc(info.l1ContractAddresses.registryAddress.toString())
	const deployBlock = await l1.pub.getBlockNumber()
	const registry = o.registry ? await deployRegistry(l2, o.registry) : undefined
	const aspRegistry = registry ? lc(registry.address.toString()) : (NO_ASP_REGISTRY as Hex)
	const journal = openDeployJournal(join(o.dataDir, "journal.jsonl"), {
		l1ChainId: o.chainId,
		rollupVersion: Number(info.rollupVersion),
		deployer: lc(l1.account.address),
		registry: registryL1,
	})
	const inputs = { registry: registryL1, pool: o.pool.poolVault, lifetimeCap: o.lifetimeCap, guardianL1: l1.account.address, aspRegistry }
	const gen = await deployGeneration(l1, l2, inputs, journal)
	const token = await preCreateToken(l1, l2, gen, o.pool.asset, journal)
	const block = {
		factory: gen.l1.factory,
		portal: token.portal as Address,
		hub: lc(gen.l2.hub.address),
		token: lc(token.l2Token),
		registry: aspRegistry,
		deployBlock,
	}
	return { gen, block, ...(registry ? { registry } : {}) }
}

/**
 * Deploys a generation and pre-creates the pool asset's portal, with entries paused. The deployer's
 * PXE is stopped before this rejects; on success the caller owns `stop()` from the moment it returns.
 */
export async function deployBridgeGeneration(o: DeployBridgeOptions): Promise<UnopenedBridge> {
	const node = createNode(o.aztecNode)
	const wallet = (await createL2Wallet({
		nodeUrl: o.aztecNode,
		proverEnabled: false,
		sandboxKeysOnly: true,
		dataDirectory: join(o.dataDir, "pxe"),
	})) as unknown as Wallet
	let stopped: Promise<void> | undefined
	const stop = () => {
		stopped ??= (wallet as unknown as { stop(): Promise<void> }).stop()
		return stopped
	}
	try {
		const l1 = l1For(o)
		const l2 = await l2For(o, wallet, node)
		const { gen, block, registry } = await deployOnto(o, l1, l2)
		const expected: ExpectedBindings = {
			factory: gen.l1.factory,
			implementation: gen.l1.implementation,
			hub: block.hub,
			guardian: lc(l1.account.address),
			...(await rollupEndpointsOf(node)),
			pool: lc(o.pool.poolVault),
			lifetimeCap: o.lifetimeCap,
			portals: [{ token: lc(o.pool.asset), portal: lc(block.portal) }],
		}
		const u: UnopenedBridge = Object.freeze({
			block: Object.freeze(block),
			expected: Object.freeze(expected),
			stop,
			get stopped() {
				return stopped !== undefined
			},
		})
		internals.set(u, { l1, wallet, node, from: l2.from, gen, asset: o.pool.asset, ...(registry ? { registry } : {}) })
		return u
	} catch (e) {
		await stop().catch(() => {})
		throw e
	}
}

/** The checks read `expected` and the opening writes to the handle's factory, so both must be one generation. */
function assertOwnGeneration(h: Internals, block: StackBridgeBlock, e: ExpectedBindings): void {
	const own =
		isAddressEqual(e.factory, block.factory) &&
		isAddressEqual(e.implementation, h.gen.l1.implementation) &&
		e.hub.toLowerCase() === block.hub &&
		e.portals.some((p) => isAddressEqual(p.token, h.asset) && isAddressEqual(p.portal, block.portal))
	if (!own) throw new Error("the expected bindings name another generation than the one this handle deployed")
}

async function readBack(h: Internals, block: StackBridgeBlock): Promise<void> {
	const read = (functionName: "portalOf" | "predictPortal") =>
		h.l1.pub.readContract({ address: block.factory, abi: PORTAL_FACTORY_ABI, functionName, args: [h.asset] })
	const [portal, predicted] = await Promise.all([read("portalOf"), read("predictPortal")])
	if (!isAddressEqual(portal, predicted) || !isAddressEqual(portal, block.portal))
		throw new Error(`factory.portalOf(asset) ${portal} is not predictPortal(asset) ${predicted} or the deployed ${block.portal}`)
	const hub = await registerHub(h.wallet, h.gen.l2.hub)
	const token = await hubTokenFor(hub, h.asset, h.from.toString())
	if (token?.toLowerCase() !== block.token) throw new Error(`hub.token_for(asset) is ${token}, not the deployed ${block.token}`)
}

/**
 * Opens entries once the deployment reads back as `expected`: portal and token lookups, every
 * factory and implementation binding, and a v1 hub (a legacy hub would strand every bridge behind
 * a message nothing can claim). Any mismatch throws with entries still paused.
 * @throws BindingMismatchError, LegacyHubError, or Error naming the read that disagreed
 */
export async function openBridgeEntries(u: UnopenedBridge, expected: ExpectedBindings): Promise<StackBridgeBlock> {
	const h = internals.get(u)
	if (!h) throw new Error("openBridgeEntries takes the value deployBridgeGeneration returned")
	assertOwnGeneration(h, u.block, expected)
	await readBack(h, u.block)
	await assertGenerationBindings(h.l1.pub as never, expected, "stack bridge")
	await assertV1Hub(h.node as never, AztecAddress.fromStringUnsafe(u.block.hub), tokenBridgeHubArtifact)
	const factory = { address: u.block.factory, abi: PORTAL_FACTORY_ABI } as const
	const hash = await h.l1.wallet.writeContract({
		...factory,
		functionName: "setEntriesPaused",
		args: [false],
		account: h.l1.account,
		chain: h.l1.wallet.chain,
	})
	if ((await h.l1.pub.waitForTransactionReceipt({ hash })).status !== "success")
		throw new Error(`setEntriesPaused(false) reverted (${hash})`)
	if (await h.l1.pub.readContract({ ...factory, functionName: "entriesPaused" })) throw new Error("entries still paused after opening")
	return u.block
}

/** The generation's L1 owner reads, for a caller checking that entries stayed paused. */
export async function entriesPaused(u: UnopenedBridge): Promise<boolean> {
	const h = internals.get(u)
	if (!h) throw new Error("entriesPaused takes the value deployBridgeGeneration returned")
	return h.l1.pub.readContract({ address: u.block.factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })
}

/** The registry's admin, poster and birth intake as the deployed contract reports them. */
export async function registryViews(u: UnopenedBridge): Promise<{ admin: Hex; poster: Hex; birthIntake: Hex }> {
	const h = internals.get(u)
	if (!h?.registry) throw new Error("registryViews takes a generation deployed with registry inputs")
	const registry = h.registry
	const read = async (name: "get_admin" | "get_poster" | "get_birth_intake") => {
		const r = (await registry.methods[name]().simulate({ from: h.from } as never)) as { result?: unknown }
		return lc(String(r.result ?? r))
	}
	return { admin: await read("get_admin"), poster: await read("get_poster"), birthIntake: await read("get_birth_intake") }
}
