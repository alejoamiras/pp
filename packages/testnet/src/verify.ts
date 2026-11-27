/**
 * The read-only checks `verify-deployment` runs. Each returns what it compared, or throws a
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

const FACTORY_ARGS = [
	{ type: "address", name: "registry" },
	{ type: "bytes32", name: "l2Hub" },
	{ type: "address", name: "pool" },
	{ type: "uint256", name: "lifetimeCap" },
	{ type: "address", name: "guardian" },
] as const
const FACTORY_ARGS_BYTES = 32 * FACTORY_ARGS.length

export type FactoryExpectation = { deployer: Address; registry: Address; hub: Hex; pool: Address; lifetimeCap: bigint; guardian: Address }

/**
 * The factory's creation transaction came from `deployer`, created `factory`, carries the committed
 * creation code (metadata aside) and exactly the expected constructor arguments.
 */
export async function checkFactoryCreation(l1: PublicClient, txHash: Hex, factory: Address, want: FactoryExpectation): Promise<void> {
	const [tx, receipt] = await Promise.all([l1.getTransaction({ hash: txHash }), l1.getTransactionReceipt({ hash: txHash })])
	sameAddress("factory creator", tx.from, want.deployer)
	if (tx.to !== null || !receipt.contractAddress) throw new VerifyError("factory creation", `${txHash} is not a contract creation`)
	sameAddress("factory address", receipt.contractAddress, factory)
	const n = size(tx.input)
	if (n <= FACTORY_ARGS_BYTES) throw new VerifyError("factory creation", "the input is shorter than its constructor arguments")
	const code = creationCodeHash(slice(tx.input, 0, n - FACTORY_ARGS_BYTES))
	if (code !== CREATION_CODES.PortalFactory)
		throw new VerifyError("factory creation code", `${code}, committed ${CREATION_CODES.PortalFactory}`)
	const [registry, l2Hub, pool, lifetimeCap, guardian] = decodeAbiParameters(FACTORY_ARGS, slice(tx.input, n - FACTORY_ARGS_BYTES))
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
