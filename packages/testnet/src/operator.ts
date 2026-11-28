/**
 * The re-read every command that signs on an operator target runs before it reads a key: the pool's
 * four proxies and their implementations' code, the wiring between them, the vault's deposit and ragequit
 * verifiers and its 1x1 transact route, the vault's pause and the entrypoint's depositor role, and the
 * asset's configuration, all at one block number, against the file's `operator` block. The operator can
 * change any of them; this is the tripwire that stops a run on a pool it was not reviewed against.
 */
import { type CodeReader, codeMismatches, readPoolCode, routeOf, routeSlot } from "@pp/sepolia-fork/pins"
import {
	type Address,
	BaseError,
	ContractFunctionRevertedError,
	ContractFunctionZeroDataError,
	type Hex,
	keccak256,
	parseAbi,
	toBytes,
} from "viem"
import { GuardError } from "./errors"
import type { TestnetDeployment } from "./schema"

type Operator = NonNullable<TestnetDeployment["operator"]>
type Pool = NonNullable<TestnetDeployment["pool"]>

const ABI = parseAbi([
	"function depositVerifier() view returns (address)",
	"function ragequitVerifier() view returns (address)",
	"function keystore() view returns (address)",
	"function aspRegistry() view returns (address)",
	"function poolVault() view returns (address)",
	"function paused() view returns (bool)",
	"function ACCESS_ROUTER() view returns (address)",
	"function hasRole(bytes32 role, address account) view returns (bool)",
	"function assets(address asset) view returns ((bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee))",
])
type Getter =
	| "depositVerifier"
	| "ragequitVerifier"
	| "keystore"
	| "aspRegistry"
	| "poolVault"
	| "paused"
	| "ACCESS_ROUTER"
	| "hasRole"
	| "assets"
type Args = readonly [Address] | readonly [Hex, Address]

/** The vault's `deposit` requires it of its caller, the entrypoint. */
const DEPOSITOR_ROLE = keccak256(toBytes("DEPOSITOR_ROLE"))

/** The reads, with viem's parameter names, so a viem `PublicClient` serves as one. */
export interface OperatorReader extends CodeReader {
	readContract(args: { address: Address; abi: typeof ABI; functionName: Getter; args?: Args; blockNumber: bigint }): Promise<unknown>
	getBlockNumber(): Promise<bigint>
}

type Read = <T>(field: string, address: Address, functionName: Getter, args?: Args) => Promise<T | undefined>

const codeHash = async (l1: CodeReader, address: Address, blockNumber: bigint): Promise<Hex> => {
	const code = await l1.getCode({ address, blockNumber })
	return keccak256(code === undefined ? "0x" : code)
}

const differs = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase()

/** What a getter that no longer answers did, or undefined for a transport failure, which must throw. */
function unanswered(e: unknown): string | undefined {
	if (!(e instanceof BaseError)) return undefined
	if (e.walk((c) => c instanceof ContractFunctionRevertedError)) return "reverted"
	if (e.walk((c) => c instanceof ContractFunctionZeroDataError)) return "returned nothing"
	return undefined
}

/** A getter at `blockNumber`; one that reverts or returns nothing is drift named `<field> (reverted)`, and yields undefined. */
const reader =
	(l1: OperatorReader, blockNumber: bigint, drift: string[]): Read =>
	async <T>(field: string, address: Address, functionName: Getter, args?: Args) => {
		try {
			return (await l1.readContract({ address, abi: ABI, functionName, args, blockNumber })) as T
		} catch (e) {
			const how = unanswered(e)
			if (!how) throw e
			drift.push(`${field} (${how})`)
			return undefined
		}
	}

/** Each contract still points at the pool section's others: the operator can repoint any of these by storage. */
async function wiringDrift(read: Read, pool: Pool, drift: string[]): Promise<void> {
	const links: [string, Address, Getter, Address][] = [
		["wiring.entrypoint.poolVault", pool.entrypoint, "poolVault", pool.poolVault],
		["wiring.vault.keystore", pool.poolVault, "keystore", pool.keystore],
		["wiring.vault.aspRegistry", pool.poolVault, "aspRegistry", pool.aspRegistry],
	]
	for (const [field, at, getter, expected] of links) {
		const actual = await read<Address>(field, at, getter)
		if (actual !== undefined && differs(actual, expected)) drift.push(field)
	}
}

async function verifierDrift(l1: OperatorReader, read: Read, o: Operator, pool: Pool, blockNumber: bigint, drift: string[]) {
	for (const field of ["depositVerifier", "ragequitVerifier"] as const) {
		const verifier = await read<Address>(`${field}.verifier`, pool.poolVault, field)
		if (verifier === undefined) continue
		if (differs(verifier, o[field].verifier)) drift.push(`${field}.verifier`)
		if (differs(await codeHash(l1, verifier, blockNumber), o[field].codeHash)) drift.push(`${field}.codeHash`)
	}
	const slot = await l1.getStorageAt({ address: pool.poolVault, slot: routeSlot(1n, 1n), blockNumber })
	const route = routeOf(slot ?? `0x${"00".repeat(32)}`)
	if (differs(route.verifier, o.transactRoute1x1.verifier)) drift.push("transactRoute1x1.verifier")
	if (differs(route.selector, o.transactRoute1x1.selector)) drift.push("transactRoute1x1.selector")
	if (differs(await codeHash(l1, route.verifier, blockNumber), o.transactRoute1x1.codeHash)) drift.push("transactRoute1x1.codeHash")
}

/** The two switches that make our deposits revert: the vault's pause, and the entrypoint's depositor role. */
async function controlDrift(read: Read, pool: Pool, drift: string[]): Promise<void> {
	if ((await read<boolean>("vault.paused", pool.poolVault, "paused")) === true) drift.push("vault.paused")
	const router = await read<Address>("vault.accessRouter", pool.poolVault, "ACCESS_ROUTER")
	if (router === undefined) return
	const role = await read<boolean>("entrypoint.depositorRole", router, "hasRole", [DEPOSITOR_ROLE, pool.entrypoint])
	if (role === false) drift.push("entrypoint.depositorRole")
}

async function assetDrift(read: Read, o: Operator, pool: Pool, drift: string[]): Promise<void> {
	type Config = { enabled: boolean; minAmount: bigint; vettingFeeBPS: bigint }
	const asset = await read<Config>("asset", pool.entrypoint, "assets", [o.asset.address])
	if (asset === undefined) return
	if (!asset.enabled) drift.push("asset.enabled")
	if (asset.minAmount !== o.asset.minDeposit) drift.push("asset.minDeposit")
	if (asset.vettingFeeBPS !== BigInt(o.asset.vettingFeeBps)) drift.push("asset.vettingFeeBps")
}

/**
 * The names of the `operator` fields the chain no longer matches at `blockNumber`, empty when it matches
 * all of them. Code comes first, so an upgrade that also breaks a getter is still named as one.
 * @throws when a read fails in transport; a getter that reverts is drift instead
 */
export async function operatorDrift(l1: OperatorReader, o: Operator, pool: Pool, blockNumber: bigint): Promise<string[]> {
	const proxies = { vault: pool.poolVault, entrypoint: pool.entrypoint, keystore: pool.keystore, aspRegistry: pool.aspRegistry }
	const drift = codeMismatches(o.code, await readPoolCode(l1, proxies, blockNumber))
	const read = reader(l1, blockNumber, drift)
	await wiringDrift(read, pool, drift)
	await verifierDrift(l1, read, o, pool, blockNumber, drift)
	await controlDrift(read, pool, drift)
	await assetDrift(read, o, pool, drift)
	return drift
}

/**
 * On an operator target, its pool still reads as the file's `operator` block at the chain's latest block
 * number, the state a transaction signed next executes on. A no-op on the own target, whose pool is
 * checked against the build instead.
 * @returns the block number read, or undefined on the own target
 * @throws GuardError `operator` when the block is missing or any field drifted
 */
export async function checkOperator(
	l1: OperatorReader,
	d: Pick<TestnetDeployment, "target" | "operator"> & { pool: Pool },
): Promise<bigint | undefined> {
	if (d.target === "own") return undefined
	const o = d.operator
	if (!o) throw new GuardError("operator", `target ${d.target} has no operator section; commit it from the fork run first`)
	const block = await l1.getBlockNumber()
	const drift = await operatorDrift(l1, o, d.pool, block)
	if (drift.length)
		throw new GuardError(
			"operator",
			`the pool moved since block ${o.evidence.forkBlock}, where it was reviewed: ${drift.join(", ")} differ at block ${block}`,
		)
	return block
}
