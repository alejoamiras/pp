/**
 * One bridge GENERATION: the L1 PortalFactory and the L2 TokenBridgeHub that is salted with the
 * factory's own address, plus the per-token portal pre-creation that fills the manifest's `tokens[]`.
 * Network-agnostic: a caller hands in its clients and fee methods.
 *
 * The ordering is forced by a circular binding: the hub's address derives from the factory address
 * (its salt) and the factory's constructor takes the hub. So the factory address is PREDICTED from
 * the deployer's nonce, the hub is derived against it, and the deploy refuses to broadcast if that
 * nonce moved — a factory landing anywhere else would be bound to a hub nothing can reach.
 *
 * Every irreversible step is journalled and skipped on a re-run: resume reuses the recorded
 * identities, it never derives fresh ones.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractBase, type ContractInstanceWithAddress } from "@aztec-labs/aztec.js/contracts"
import { publishContractClass } from "@aztec-labs/aztec.js/deployment"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { type Address, getContractAddress, type Hex } from "viem"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../src/artifacts"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import { type Registration, readRegistration } from "../src/factory-registry"
import type { L1Ctx } from "../src/flows"
import { assertGenerationBindings, type ExpectedBindings, rollupEndpointsOf } from "../src/generation-bindings"
import { sendGasLimit } from "../src/l1-gas"
import { hubTokenFor } from "../src/hub-l2"
import { deriveHubTokenInstance } from "../src/hub-token"
import { l1ToL2MessageReadiness } from "../src/l1-to-l2-readiness"
import type { SendOpts } from "../src/hub-l2"
import type { ManifestToken } from "../src/manifest-v2"
import { fromWord } from "../src/register-hash"
import type { DeployJournal, DeployStep, DeployStepKind } from "./deploy-manifest"
import { evmArtifact } from "./script-artifacts"
import { deriveInstance, registerHub, registerHubToken } from "./script-l2"

export type AztecNode = ReturnType<typeof createAztecNodeClient>

/** The connected L2 surface a generation deploy needs. The two send option sets differ by wait:
 *  a deploy must be CHECKPOINTED before anything can call it; a claim only has to land. */
export interface L2Ctx {
	wallet: Wallet
	node: AztecNode
	from: AztecAddress
	deployOpts: SendOpts
	sendOpts: SendOpts
	/** A network that only builds a block when a transaction arrives needs a nudge before an
	 *  L1→L2 message can ever become consumable. Omit it wherever blocks flow on their own. */
	forceBlock?: () => Promise<unknown>
}

/** A stage A generation's ASP registry: none, so its tokens run no checked spends. */
export const NO_ASP_REGISTRY = `0x${"0".repeat(64)}`

export interface GenerationInputs {
	registry: Address
	/** The Privacy Pools vault every portal of this generation is the processor for. */
	pool: Address
	/** Each portal's lifetime limit on accepted funds, in its token's base units. */
	lifetimeCap: bigint
	guardianL1: Address
	/** The ASP registry the hub passes to every token it derives, as an Aztec address hex: zero in a
	 *  generation without checked spends. Not `registry`, which is the L1 one. */
	aspRegistry: string
}

export interface GenerationRecord {
	l1: {
		factory: Address
		implementation: Address
		registry: Address
		guardian: Address
	}
	l2: {
		hub: { address: string; salt: Hex; constructorArtifact: "constructor"; constructorArgs: [string, Address, string] }
		aspRegistry: string
		tokenClassId: string
		tokenArtifactSha256: string
	}
}

const lc = (v: string) => v.toLowerCase() as Address

function findStep<K extends DeployStepKind>(journal: DeployJournal, kind: K): Extract<DeployStep, { kind: K }> | undefined {
	return journal.steps.find((s): s is Extract<DeployStep, { kind: K }> => s.kind === kind)
}

function assertSame(actual: string, expected: string, label: string): void {
	if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label}: on-chain ${actual} != expected ${expected} — STOP`)
}

// ─── L2 classes ──────────────────────────────────────────────────────────────

/** The class ids of the two artifacts a generation instantiates, recomputed on every run so a
 *  toolchain that moved either one is caught before it can be journalled as this generation's. */
async function artifactClassIds(): Promise<{ tokenClassId: string; hubClassId: string }> {
	const token = await getContractClassFromArtifact(labelledTokenArtifact)
	const hub = await getContractClassFromArtifact(tokenBridgeHubArtifact)
	return { tokenClassId: token.id.toString(), hubClassId: hub.id.toString() }
}

/** A class someone else already published (the token class on a shared network) is a no-op, not a
 *  failure: the node is asked first, and a publication that still loses the race is recognised by the
 *  registry's nullifier rejection, whose wording differs across node versions. */
async function publishIfAbsent(l2: L2Ctx, artifact: Parameters<typeof publishContractClass>[1], label: string): Promise<void> {
	const { id } = await getContractClassFromArtifact(artifact)
	if (await l2.node.getContractClass(id)) {
		console.log(`  ${label} class already published`)
		return
	}
	try {
		const interaction = await publishContractClass(l2.wallet, artifact)
		await interaction.send(l2.deployOpts as never)
		console.log(`  published ${label} class`)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (!/already|existing nullifier|duplicate nullifier|nullifier already exists/i.test(msg)) throw e
		// The rejection wording is only evidence; the class being on the node is the fact journalled.
		if (!(await l2.node.getContractClass(id)))
			throw new Error(`${label} class publication was rejected (${msg}) yet the node does not serve it — STOP`)
		console.log(`  ${label} class already published`)
	}
}

async function publishClasses(l2: L2Ctx, journal: DeployJournal): Promise<{ tokenClassId: string; hubClassId: string }> {
	const ids = await artifactClassIds()
	const recorded = findStep(journal, "classes-published")
	if (recorded) {
		assertSame(ids.tokenClassId, recorded.tokenClassId, "journalled token class id")
		assertSame(ids.hubClassId, recorded.hubClassId, "journalled hub class id")
		return ids
	}
	await publishIfAbsent(l2, labelledTokenArtifact, "LabelledToken")
	await publishIfAbsent(l2, tokenBridgeHubArtifact, "TokenBridgeHub")
	journal.append({ kind: "classes-published", ...ids })
	return ids
}

/** The bytes the manifest pins: the committed LabelledToken artifact JSON, not a re-serialization
 *  of the loaded object (which would drift with any loader change). */
function tokenArtifactSha256(): string {
	const path = new URL("../../../contracts/bridge/aztec/labelled_token/target/labelled_token-LabelledToken.json", import.meta.url)
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

// ─── L1 factory ─────────────────────────────────────────────────────

/** PENDING, not latest: a transaction of this key's already in the mempool owns the latest nonce, so
 *  a prediction made from it names an address the factory can never land at. */
const nonceOf = async (l1: L1Ctx): Promise<bigint> =>
	BigInt(await l1.pub.getTransactionCount({ address: l1.account.address, blockTag: "pending" }))

interface FactoryPrediction {
	factory: Address
	implementation: Address
}

/** The implementation is the factory's own first CREATE (nonce 1 — a contract's nonce starts at 1),
 *  so both addresses are known before either exists. */
async function predictFactory(l1: L1Ctx, journal: DeployJournal): Promise<FactoryPrediction> {
	const recorded = findStep(journal, "factory-predicted")
	if (recorded) return { factory: lc(recorded.factory), implementation: lc(recorded.implementation) }
	const factory = lc(getContractAddress({ from: l1.account.address, nonce: await nonceOf(l1) }))
	const implementation = lc(getContractAddress({ from: factory, nonce: 1n }))
	journal.append({ kind: "factory-predicted", factory, implementation })
	return { factory, implementation }
}

/** A pinned `nonce` makes the address the deploy commits to unforgeable: a nonce something else took
 *  in the meantime fails to send instead of landing the contract at an address nothing is bound to. */
async function deployEvm(l1: L1Ctx, name: string, args: unknown[], nonce?: bigint): Promise<{ address: Address; txHash: Hex }> {
	const { abi, bytecode } = evmArtifact(name)
	const txHash = await l1.wallet.deployContract({
		abi,
		bytecode,
		args,
		account: l1.account,
		chain: l1.wallet.chain,
		...(nonce === undefined ? {} : { nonce: Number(nonce) }),
	} as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash: txHash })
	if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deploy REVERTED (${txHash})`)
	console.log(`  ${name}: ${receipt.contractAddress}`)
	return { address: lc(receipt.contractAddress), txHash }
}

type RollupEndpoints = Pick<ExpectedBindings, "inbox" | "outbox" | "rollupVersion">

/** No portal exists while the factory step runs; one bound to another rollup, vault, cap or owner is refused. */
const expectedBindings = (
	predicted: FactoryPrediction,
	hub: string,
	rollup: RollupEndpoints,
	inputs: GenerationInputs,
): ExpectedBindings => ({
	factory: predicted.factory,
	implementation: predicted.implementation,
	hub: hub as Hex,
	...rollup,
	guardian: lc(inputs.guardianL1),
	pool: lc(inputs.pool),
	lifetimeCap: inputs.lifetimeCap,
	portals: [],
})

/**
 * A factory already sitting at the predicted address is this generation's — the deploy landed and
 * the process died before the journal did. Adopting it needs the bindings to agree, since a stranger
 * can also CREATE at any address a leaked key predicts.
 */
async function adoptLandedFactory(
	l1: L1Ctx,
	predicted: FactoryPrediction,
	expected: ExpectedBindings,
	journal: DeployJournal,
): Promise<FactoryPrediction | undefined> {
	const code = await l1.pub.getCode({ address: predicted.factory })
	if (!code || code === "0x") return undefined
	await assertGenerationBindings(l1.pub, expected, "landed factory")
	console.log(`  PortalFactory: ${predicted.factory} (adopted — it landed before the journal was written)`)
	journal.append({ kind: "factory-deployed", factory: predicted.factory, implementation: predicted.implementation, txHash: undefined })
	return predicted
}

async function deployFactory(
	l1: L1Ctx,
	inputs: GenerationInputs,
	predicted: FactoryPrediction,
	hubAddress: string,
	rollup: RollupEndpoints,
	journal: DeployJournal,
): Promise<FactoryPrediction> {
	const expected = expectedBindings(predicted, hubAddress, rollup, inputs)
	const done = findStep(journal, "factory-deployed")
	if (done) {
		// The hub was derived from the prediction, so a journal whose factory step disagrees with it is
		// not one generation.
		assertSame(done.factory, predicted.factory, "journalled factory address")
		assertSame(done.implementation, predicted.implementation, "journalled implementation address")
		await assertGenerationBindings(l1.pub, expected, "journalled factory")
		return predicted
	}
	const adopted = await adoptLandedFactory(l1, predicted, expected, journal)
	if (adopted) return adopted
	// The hub is already salted with the predicted address; a factory that lands anywhere else is
	// bound to a hub nothing can reach, so a moved nonce ends the generation rather than the step.
	const nonce = await nonceOf(l1)
	const live = lc(getContractAddress({ from: l1.account.address, nonce }))
	if (live !== predicted.factory) {
		throw new Error(
			`the deployer's next CREATE is ${live}, not the predicted ${predicted.factory} — this generation is dead; start a new one`,
		)
	}
	const { address, txHash } = await deployEvm(
		l1,
		"PortalFactory",
		[inputs.registry, hubAddress, inputs.pool, inputs.lifetimeCap, inputs.guardianL1],
		nonce,
	)
	assertSame(address, predicted.factory, "PortalFactory address")
	await assertGenerationBindings(l1.pub, expected, "deployed factory")
	// Entries stay paused: the factory starts them so, and opening them is the guardian's later call.
	journal.append({ kind: "factory-deployed", factory: address, implementation: predicted.implementation, txHash })
	return { factory: address, implementation: predicted.implementation }
}

// ─── L2 hub ──────────────────────────────────────────────────────────────────

type HubArgs = [string, Address, string]

const hubConstructorArgs = (tokenClassId: string, factory: Address, aspRegistry: string): HubArgs => [tokenClassId, factory, aspRegistry]

/** The registry is part of every token's address, so a malformed one is refused before any side effect. */
function validAspRegistry(aspRegistry: string): string {
	if (!/^0x[0-9a-f]{64}$/.test(aspRegistry) || BigInt(aspRegistry) >= Fr.MODULUS)
		throw new Error(`aspRegistry must be a 32-byte lower-case hex Aztec address, got ${aspRegistry}`)
	return aspRegistry
}

/** The salt IS the factory address as a field, so one factory can only ever have one hub. */
function hubSalt(factory: Address): Fr {
	return new Fr(BigInt(factory))
}

function deriveHub(tokenClassId: string, factory: Address, aspRegistry: string): Promise<ContractInstanceWithAddress> {
	return deriveInstance(
		tokenBridgeHubArtifact,
		[Fr.fromHexString(tokenClassId), EthAddress.fromString(factory), AztecAddress.fromStringUnsafe(aspRegistry)],
		"constructor",
		hubSalt(factory),
		AztecAddress.ZERO,
	)
}

/**
 * A hub already at the derived address is this generation's — the deploy landed and the process died
 * before the journal did. Redeploying it would burn the whole run on the consumed deployment
 * nullifier, so it is adopted instead; the preimage must agree, since a universal deploy lets anyone
 * occupy an address a leaked salt names.
 */
async function adoptLandedHub(l2: L2Ctx, instance: ContractInstanceWithAddress, salt: Fr, journal: DeployJournal): Promise<boolean> {
	const landed = await l2.node.getContract(instance.address)
	if (!landed) return false
	assertSame(landed.currentContractClassId.toString(), instance.currentContractClassId.toString(), "landed hub class id")
	assertSame(landed.initializationHash.toString(), instance.initializationHash.toString(), "landed hub initializationHash")
	assertSame(landed.salt.toString(), instance.salt.toString(), "landed hub salt")
	console.log(`  TokenBridgeHub: ${instance.address.toString()} (adopted — it landed before the journal was written)`)
	journal.append({ kind: "hub-deployed", hub: instance.address.toString(), salt: salt.toString(), txHash: undefined })
	return true
}

async function deployHub(
	l2: L2Ctx,
	instance: ContractInstanceWithAddress,
	args: HubArgs,
	factory: Address,
	journal: DeployJournal,
): Promise<void> {
	const done = findStep(journal, "hub-deployed")
	if (done) {
		assertSame(instance.address.toString(), done.hub, "journalled hub address")
		return
	}
	const salt = hubSalt(factory)
	if (await adoptLandedHub(l2, instance, salt, journal)) return
	const sent = (await Contract.deploy(
		l2.wallet,
		tokenBridgeHubArtifact,
		[Fr.fromHexString(args[0]), EthAddress.fromString(args[1]), AztecAddress.fromStringUnsafe(args[2])],
		"constructor",
		{ salt, universalDeploy: true } as never,
	).send(l2.deployOpts as never)) as unknown as { receipt: { txHash: unknown } }
	const deployed = await l2.node.getContract(instance.address)
	if (!deployed) throw new Error(`hub ${instance.address.toString()} is not deployed at its derived address — the salt or args diverged`)
	console.log(`  TokenBridgeHub: ${instance.address.toString()}`)
	journal.append({ kind: "hub-deployed", hub: instance.address.toString(), salt: salt.toString(), txHash: String(sent.receipt.txHash) })
}

// ─── Read-backs ──────────────────────────────────────────────────────────────

async function assertGeneration(l1: L1Ctx, l2: L2Ctx, record: GenerationRecord): Promise<void> {
	assertSame(
		String(await l1.pub.readContract({ address: record.l1.factory, abi: PORTAL_FACTORY_ABI, functionName: "L2_HUB", args: [] })),
		record.l2.hub.address,
		"factory.L2_HUB",
	)
	const hub = await registerHub(l2.wallet, record.l2.hub)
	if ((await hubTokenFor(hub, "0x0000000000000000000000000000000000000000", l2.from.toString())) !== undefined) {
		throw new Error("hub token_for(0x0) answered a non-zero token — the hub is not the freshly-constructed one")
	}
	console.log("  ✓ factory.L2_HUB, hub.token_for")
}

export async function deployGeneration(l1: L1Ctx, l2: L2Ctx, inputs: GenerationInputs, journal: DeployJournal): Promise<GenerationRecord> {
	const aspRegistry = validAspRegistry(inputs.aspRegistry)
	const { tokenClassId } = await publishClasses(l2, journal)
	const predicted = await predictFactory(l1, journal)
	const args = hubConstructorArgs(tokenClassId, predicted.factory, aspRegistry)
	const hubInstance = await deriveHub(tokenClassId, predicted.factory, aspRegistry)
	// The hub deploys to the rollup this node follows, so the implementation must pin that one.
	const rollup = await rollupEndpointsOf(l2.node)
	const { factory, implementation } = await deployFactory(l1, inputs, predicted, hubInstance.address.toString(), rollup, journal)
	await deployHub(l2, hubInstance, args, factory, journal)

	const record: GenerationRecord = {
		l1: {
			factory,
			implementation,
			registry: lc(inputs.registry),
			guardian: lc(inputs.guardianL1),
		},
		l2: {
			hub: {
				address: hubInstance.address.toString(),
				salt: hubSalt(factory).toString() as Hex,
				constructorArtifact: "constructor",
				constructorArgs: args,
			},
			aspRegistry,
			tokenClassId,
			tokenArtifactSha256: tokenArtifactSha256(),
		},
	}
	await assertGeneration(l1, l2, record)
	return record
}

// ─── Per-token pre-creation ──────────────────────────────────────────────────

export interface MessageWaitOptions {
	timeoutMs?: number
	/** See {@link L2Ctx.forceBlock} — without it the anchor on a quiescent chain never moves. */
	forceBlock?: () => Promise<unknown>
}

/**
 * An L1→L2 message is consumable once the latest block's message tree has passed its leaf. A claim
 * built before that cannot produce a membership witness, so registration waits here rather than
 * burning the token's one-shot register leaf on a doomed attempt.
 */
export async function waitForL1ToL2Message(node: AztecNode, messageHash: string, opts: MessageWaitOptions = {}): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 300_000
	const start = Date.now()
	let last: Awaited<ReturnType<typeof l1ToL2MessageReadiness>> = null
	while (Date.now() - start < timeoutMs) {
		last = await l1ToL2MessageReadiness(node, messageHash)
		if (last && last.anchor >= last.checkpoint) return
		if (opts.forceBlock) await opts.forceBlock().catch(() => {})
		await new Promise((r) => setTimeout(r, 1500))
	}
	throw new Error(
		last
			? `the node's message tree never reached checkpoint ${last.checkpoint} for message ${messageHash} within ${timeoutMs}ms`
			: `L1→L2 message ${messageHash} was not ingested within ${timeoutMs}ms`,
	)
}

export interface PreCreateTokenOptions {
	/** Consume the factory's register message now; `false` leaves it for the first claim. */
	register?: boolean
	source?: ManifestToken["source"]
	sourceContract?: ManifestToken["sourceContract"]
	maxWholePerTx?: number
}

export { sendGasLimit }

/** The token's frozen registration, creating its portal first when the factory has none. A portal
 *  another account created reads back the same registration, so no event of this run is trusted. */
export async function ensurePortal(l1: L1Ctx, factory: Address, erc20: Address): Promise<{ reg: Registration; txHash?: Hex }> {
	const existing = await readRegistration(l1.pub as never, factory, erc20)
	if (existing) return { reg: existing }
	// createPortal sends the factory's register message through the Inbox, so it takes a bridge send's
	// gas headroom; a bare estimate has run out of gas on it.
	const call = { address: factory, abi: PORTAL_FACTORY_ABI, functionName: "createPortal", args: [erc20], account: l1.account }
	const estimate = await l1.pub.estimateContractGas(call as never)
	const txHash = await l1.wallet.writeContract({ ...call, chain: l1.wallet.chain, gas: sendGasLimit(estimate) } as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash: txHash })
	if (receipt.status !== "success") throw new Error(`createPortal(${erc20}) REVERTED (${txHash}) — no portal was created; inspect the tx`)
	const reg = await readRegistration(l1.pub as never, factory, erc20)
	if (!reg) throw new Error(`createPortal(${erc20}) landed but the factory has no registration — STOP`)
	return { reg, txHash }
}

function registerArgs(erc20: Address, reg: Registration) {
	return [
		EthAddress.fromString(erc20),
		EthAddress.fromString(reg.portal),
		Fr.fromHexString(reg.nameWord),
		Fr.fromHexString(reg.symbolWord),
		reg.decimals,
		new Fr(reg.registerIndex),
	] as const
}

async function registerOnHub(l2: L2Ctx, hub: ContractBase, erc20: Address, reg: Registration): Promise<string | undefined> {
	if (await hubTokenFor(hub, erc20, l2.from.toString())) return undefined
	await waitForL1ToL2Message(l2.node, reg.registerKey, { forceBlock: l2.forceBlock })
	const sent = (await hub.methods.register_token(...registerArgs(erc20, reg)).send(l2.sendOpts as never)) as unknown as {
		receipt: { txHash: unknown }
	}
	return String(sent.receipt.txHash)
}

async function manifestTokenOf(
	gen: GenerationRecord,
	erc20: Address,
	reg: Registration,
	opts: PreCreateTokenOptions,
): Promise<ManifestToken> {
	const instance = await deriveHubTokenInstance(
		AztecAddress.fromStringUnsafe(gen.l2.hub.address),
		erc20,
		{ nameWord: reg.nameWord, symbolWord: reg.symbolWord, decimals: reg.decimals },
		gen.l2.tokenClassId,
		AztecAddress.fromStringUnsafe(gen.l2.aspRegistry),
	)
	// The manifest demands non-empty display strings; a token whose metadata the factory froze as
	// empty still has to render as something, so fall back down to the address.
	const displaySymbol = fromWord(reg.symbolWord) || erc20.slice(2, 8)
	return {
		erc20: erc20.toLowerCase(),
		portal: reg.portal.toLowerCase(),
		l2Token: instance.address.toString(),
		nameWord: reg.nameWord,
		symbolWord: reg.symbolWord,
		decimals: reg.decimals,
		displayName: fromWord(reg.nameWord) || displaySymbol,
		displaySymbol,
		source: opts.source ?? "permissionless-mint",
		sourceContract: opts.sourceContract ?? "MintableERC20",
		...(opts.maxWholePerTx === undefined ? {} : { maxWholePerTx: opts.maxWholePerTx }),
	}
}

/** Creates the token's portal clone (idempotent on L1) and, unless told otherwise, consumes the
 *  factory's register message on the hub so the token's first depositor takes the plain claim path. */
export async function preCreateToken(
	l1: L1Ctx,
	l2: L2Ctx,
	gen: GenerationRecord,
	erc20: Address,
	journal: DeployJournal,
	opts: PreCreateTokenOptions = {},
): Promise<ManifestToken> {
	const { reg, txHash } = await ensurePortal(l1, gen.l1.factory, erc20)
	const token = await manifestTokenOf(gen, erc20, reg, opts)
	// A per-run wallet store has never seen the hub, even one this run's `deploy` adopted rather than
	// deployed, and the PXE cannot simulate `token_for` on an instance it does not hold.
	const hub = await registerHub(l2.wallet, gen.l2.hub)
	// `register_token` enqueues the derived Token's constructor, so the wallet must hold that
	// instance before it can even BUILD the transaction — the oracle resolves the callee locally.
	await registerHubToken(l2.wallet, AztecAddress.fromStringUnsafe(gen.l2.hub.address), token, gen.l2.tokenClassId, gen.l2.aspRegistry)
	const registerTxHash = opts.register === false ? undefined : await registerOnHub(l2, hub, erc20, reg)
	if (!journal.has("token-precreated", erc20)) {
		journal.append({ kind: "token-precreated", erc20: erc20.toLowerCase(), portal: reg.portal.toLowerCase(), txHash, registerTxHash })
	}
	console.log(`  ${token.displaySymbol} ${erc20} → portal ${token.portal}${registerTxHash ? " (registered)" : ""}`)
	return token
}
