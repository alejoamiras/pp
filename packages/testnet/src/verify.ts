/**
 * The read-only checks `verify-deployment` and `seed` run. Each returns what it compared, or throws a
 * `VerifyError` naming the first disagreement; none signs or writes.
 */
import {
	type Address,
	decodeAbiParameters,
	type Hex,
	isAddressEqual,
	keccak256,
	maxUint256,
	parseAbi,
	parseAbiItem,
	type PublicClient,
	size,
	slice,
	toBytes,
} from "viem"
import { CREATION_CODES, creationCodeHash } from "./creation"

export class VerifyError extends Error {
	override readonly name = "VerifyError"
	constructor(
		readonly check: string,
		detail: string,
	) {
		super(`${check}: ${detail}`)
	}
}

const POOL_ABI = parseAbi([
	"function poolVault() view returns (address)",
	"function assets(address asset) view returns ((bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee))",
	"function aspRegistry() view returns (address)",
	"function keystore() view returns (address)",
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function latestASPRoot() view returns (uint256)",
])
const FACTORY_ABI = parseAbi(["function entriesPaused() view returns (bool)"])
const POSTMAN_ROLE = keccak256(toBytes("POSTMAN_ROLE"))

const sameAddress = (check: string, got: Address, want: Address) => {
	if (!isAddressEqual(got, want)) throw new VerifyError(check, `${got}, the file names ${want}`)
}

export type PoolBindings = {
	poolVault: Address
	entrypoint: Address
	aspRegistry: Address
	keystore: Address
	asset: Address
	accessRouter?: Address
}

/** An enabled asset's configuration; `maxRelayFee` is checked only when given. */
export type AssetExpectation = { minAmount: bigint; vettingFeeBps: bigint; maxRelayFee?: bigint }

/** What the own pool's deploy sets: minimum 1, no vetting fee, no relay-fee cap. */
export const OWN_ASSET: AssetExpectation = { minAmount: 1n, vettingFeeBps: 0n, maxRelayFee: maxUint256 }

/**
 * The entrypoint routes to the file's vault, the vault to its registry and keystore, `postman` holds
 * the postman role, and the asset is enabled at `asset`.
 */
export async function checkPoolBindings(
	l1: PublicClient,
	p: PoolBindings,
	postman: Address | undefined,
	asset: AssetExpectation,
): Promise<void> {
	const read = <F extends "poolVault" | "aspRegistry" | "keystore">(address: Address, functionName: F) =>
		l1.readContract({ address, abi: POOL_ABI, functionName }) as Promise<Address>
	sameAddress("entrypoint.poolVault", await read(p.entrypoint, "poolVault"), p.poolVault)
	sameAddress("vault.aspRegistry", await read(p.poolVault, "aspRegistry"), p.aspRegistry)
	sameAddress("vault.keystore", await read(p.poolVault, "keystore"), p.keystore)
	if (postman && p.accessRouter) {
		const holds = await l1.readContract({
			address: p.accessRouter,
			abi: POOL_ABI,
			functionName: "hasRole",
			args: [POSTMAN_ROLE, postman],
		})
		if (!holds) throw new VerifyError("postman role", `${postman} does not hold it`)
	}
	const config = await l1.readContract({ address: p.entrypoint, abi: POOL_ABI, functionName: "assets", args: [p.asset] })
	const relayFee = asset.maxRelayFee === undefined || config.maxRelayFee === asset.maxRelayFee
	if (!config.enabled || config.minAmount !== asset.minAmount || config.vettingFeeBPS !== asset.vettingFeeBps || !relayFee)
		throw new VerifyError(
			"asset config",
			`${p.asset}: enabled ${config.enabled}, minimum ${config.minAmount}, vetting fee ${config.vettingFeeBPS} bps, relay-fee cap ${config.maxRelayFee}`,
		)
}

/** FeeCalculator.MAX_FEE_BPS. */
const MAX_FEE_BPS = 10_000n

/**
 * A deposit of a note worth `amounts.note` is accepted and debits exactly `amounts.debit`.
 * `Entrypoint.deposit` refuses a disabled asset or a value below `minAmount`, then pulls the value
 * plus `FeeCalculator.calcFee(value, vettingFeeBPS)`, which is `value * bps / 10_000` rounded down.
 * @throws VerifyError `deposit amounts` when the asset config refuses the note or debits another amount
 */
export async function checkDepositDebit(
	l1: PublicClient,
	entrypoint: Address,
	asset: Address,
	amounts: { note: bigint; debit: bigint },
): Promise<void> {
	const c = await l1.readContract({ address: entrypoint, abi: POOL_ABI, functionName: "assets", args: [asset] })
	const pulled = amounts.note + (amounts.note * c.vettingFeeBPS) / MAX_FEE_BPS
	if (!c.enabled || amounts.note < c.minAmount || pulled !== amounts.debit)
		throw new VerifyError(
			"deposit amounts",
			`a note of ${amounts.note} debits ${pulled} at ${c.vettingFeeBPS} bps (enabled ${c.enabled}, minimum ${c.minAmount}); the file expects ${amounts.debit}`,
		)
}

const INITIALIZED = parseAbiItem("event Initialized(uint64 version)")
/** The widest `eth_getLogs` range both pinned L1 endpoints accept. */
const LOG_WINDOW = 10_000n

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]

/**
 * Discovery starts at `deployBlock`, so no pool event may precede it and the endpoint must serve logs
 * from it. None of vault, keystore and entrypoint has code at `deployBlock − 1`, so none can have
 * emitted an event before it; the vault's `Initialized` log comes back within a log window from it,
 * so the endpoint holds that history and answers it rather than an empty list.
 * @returns the block of the vault's first `Initialized` log
 */
export async function checkDeployBlock(l1: PublicClient, p: PoolBindings & { deployBlock: bigint }): Promise<bigint> {
	if (p.deployBlock === 0n) throw new VerifyError("deploy block", "0, so discovery would scan from genesis")
	const before = p.deployBlock - 1n
	const contracts = { vault: p.poolVault, keystore: p.keystore, entrypoint: p.entrypoint }
	for (const [name, address] of Object.entries(contracts)) {
		const code = await l1.getCode({ address, blockNumber: before }).catch((e: unknown) => {
			throw new VerifyError("deploy block", `the endpoint serves no state at block ${before}: ${firstLine(e)}`)
		})
		if (code !== undefined && code !== "0x") throw new VerifyError("deploy block", `the ${name} ${address} has code at block ${before}`)
	}
	const head = await l1.getBlockNumber()
	const toBlock = p.deployBlock + LOG_WINDOW - 1n < head ? p.deployBlock + LOG_WINDOW - 1n : head
	const logs = await l1.getLogs({ address: p.poolVault, event: INITIALIZED, fromBlock: p.deployBlock, toBlock }).catch((e: unknown) => {
		throw new VerifyError("deploy block", `the endpoint serves no logs from block ${p.deployBlock}: ${firstLine(e)}`)
	})
	const at = logs[0]?.blockNumber
	if (at === undefined || at === null)
		throw new VerifyError("deploy block", `the vault has no Initialized log in blocks ${p.deployBlock} to ${toBlock}`)
	return at
}

const FACTORY_ARGS = [
	{ type: "address", name: "registry" },
	{ type: "bytes32", name: "l2Hub" },
	{ type: "address", name: "pool" },
	{ type: "uint256", name: "lifetimeCap" },
	{ type: "address", name: "guardian" },
] as const
const FACTORY_ARGS_BYTES = 32 * FACTORY_ARGS.length

export type FactoryExpectation = {
	deployer: Address
	registry: Address
	hub: Hex
	pool: Address
	lifetimeCap: bigint
	guardian: Address
	/** The bridge section's `deployBlock`, where discovery starts reading `PortalCreated`. */
	deployBlock: bigint
}

/**
 * The factory's creation transaction came from `deployer`, created `factory` no earlier than
 * `deployBlock`, carries the committed creation code (metadata aside) at its pinned size, and exactly the
 * expected constructor arguments after it, where the constructor reads them.
 */
export async function checkFactoryCreation(l1: PublicClient, txHash: Hex, factory: Address, want: FactoryExpectation): Promise<void> {
	const [tx, receipt] = await Promise.all([l1.getTransaction({ hash: txHash }), l1.getTransactionReceipt({ hash: txHash })])
	sameAddress("factory creator", tx.from, want.deployer)
	if (tx.to !== null || !receipt.contractAddress) throw new VerifyError("factory creation", `${txHash} is not a contract creation`)
	sameAddress("factory address", receipt.contractAddress, factory)
	if (want.deployBlock > receipt.blockNumber)
		throw new VerifyError("bridge deploy block", `${want.deployBlock} follows the factory's creation in block ${receipt.blockNumber}`)
	const pin = CREATION_CODES.PortalFactory
	if (size(tx.input) !== pin.size + FACTORY_ARGS_BYTES)
		throw new VerifyError(
			"factory creation",
			`the input is ${size(tx.input)} bytes, not the pinned code's ${pin.size} and ${FACTORY_ARGS_BYTES} of arguments`,
		)
	const code = creationCodeHash(slice(tx.input, 0, pin.size))
	if (code !== pin.hash) throw new VerifyError("factory creation code", `${code}, committed ${pin.hash}`)
	const [registry, l2Hub, pool, lifetimeCap, guardian] = decodeAbiParameters(FACTORY_ARGS, slice(tx.input, pin.size))
	sameAddress("factory registry", registry, want.registry)
	if (BigInt(l2Hub) !== BigInt(want.hub)) throw new VerifyError("factory hub", `${l2Hub}, the file names ${want.hub}`)
	sameAddress("factory pool", pool, want.pool)
	if (lifetimeCap !== want.lifetimeCap) throw new VerifyError("factory cap", `${lifetimeCap}, the file names ${want.lifetimeCap}`)
	sameAddress("factory guardian", guardian, want.guardian)
}

export async function checkEntriesPaused(l1: PublicClient, factory: Address): Promise<void> {
	if (!(await l1.readContract({ address: factory, abi: FACTORY_ABI, functionName: "entriesPaused" })))
		throw new VerifyError("entries", "open: a deployment is verified paused, and only `open` opens it")
}

/** The record's pool root is the registry's latest root at the record's L1 block, and its time that block's. */
export async function checkRecordRoot(
	l1: PublicClient,
	aspRegistry: Address,
	r: { poolRoot: bigint; l1Block: bigint; rootTime: bigint },
): Promise<void> {
	const [root, block] = await Promise.all([
		l1.readContract({ address: aspRegistry, abi: POOL_ABI, functionName: "latestASPRoot", blockNumber: r.l1Block }),
		l1.getBlock({ blockNumber: r.l1Block }),
	])
	if (root !== r.poolRoot)
		throw new VerifyError("record root", `pool_root ${r.poolRoot}, the registry held ${root} at block ${r.l1Block}`)
	if (block.timestamp !== r.rootTime)
		throw new VerifyError("record time", `root_time ${r.rootTime}, block ${r.l1Block} is at ${block.timestamp}`)
}
