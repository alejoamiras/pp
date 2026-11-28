/**
 * The re-read every command that signs on an operator target runs before it reads a key: the pool's
 * four proxies and their implementations' code, the vault's deposit verifier and its 1x1 transact route,
 * and the asset's configuration, all at one block, against the file's `operator` block. The operator
 * can upgrade any of them; this is the tripwire that stops a run on a pool it was not reviewed against.
 */
import { type CodeReader, codeMismatches, readPoolCode, routeOf, routeSlot } from "@pp/sepolia-fork/pins"
import { type Address, type Hex, keccak256, parseAbi } from "viem"
import { GuardError } from "./errors"
import type { TestnetDeployment } from "./schema"

type Operator = NonNullable<TestnetDeployment["operator"]>
type Pool = NonNullable<TestnetDeployment["pool"]>

const ABI = parseAbi([
	"function depositVerifier() view returns (address)",
	"function assets(address asset) view returns ((bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee))",
])

/** The reads, with viem's parameter names, so a viem `PublicClient` serves as one. */
export interface OperatorReader extends CodeReader {
	readContract(args: {
		address: Address
		abi: typeof ABI
		functionName: "depositVerifier" | "assets"
		args?: readonly [Address]
		blockNumber: bigint
	}): Promise<unknown>
	getBlockNumber(): Promise<bigint>
}

const codeHash = async (l1: CodeReader, address: Address, blockNumber: bigint): Promise<Hex> => {
	const code = await l1.getCode({ address, blockNumber })
	return keccak256(code === undefined ? "0x" : code)
}

const differs = (a: string, b: string) => a.toLowerCase() !== b.toLowerCase()

/** The names of the `operator` fields the chain no longer matches at `blockNumber`, empty when it matches all of them. */
export async function operatorDrift(l1: OperatorReader, o: Operator, pool: Pool, blockNumber: bigint): Promise<string[]> {
	const proxies = { vault: pool.poolVault, entrypoint: pool.entrypoint, keystore: pool.keystore, aspRegistry: pool.aspRegistry }
	const code = await readPoolCode(l1, proxies, blockNumber)
	const verifier = (await l1.readContract({ address: pool.poolVault, abi: ABI, functionName: "depositVerifier", blockNumber })) as Address
	const slot = await l1.getStorageAt({ address: pool.poolVault, slot: routeSlot(1n, 1n), blockNumber })
	const route = routeOf(slot ?? `0x${"00".repeat(32)}`)
	const asset = (await l1.readContract({
		address: pool.entrypoint,
		abi: ABI,
		functionName: "assets",
		args: [o.asset.address],
		blockNumber,
	})) as { enabled: boolean; minAmount: bigint; vettingFeeBPS: bigint }
	const drift = codeMismatches(o.code, code)
	if (differs(verifier, o.depositVerifier.verifier)) drift.push("depositVerifier.verifier")
	if (differs(await codeHash(l1, verifier, blockNumber), o.depositVerifier.codeHash)) drift.push("depositVerifier.codeHash")
	if (differs(route.verifier, o.transactRoute1x1.verifier)) drift.push("transactRoute1x1.verifier")
	if (differs(route.selector, o.transactRoute1x1.selector)) drift.push("transactRoute1x1.selector")
	if (differs(await codeHash(l1, route.verifier, blockNumber), o.transactRoute1x1.codeHash)) drift.push("transactRoute1x1.codeHash")
	if (!asset.enabled) drift.push("asset.enabled")
	if (asset.minAmount !== o.asset.minDeposit) drift.push("asset.minDeposit")
	if (asset.vettingFeeBPS !== BigInt(o.asset.vettingFeeBps)) drift.push("asset.vettingFeeBps")
	return drift
}

/**
 * On an operator target, its pool still reads as the file's `operator` block at the chain's latest block,
 * the state a transaction signed next executes on. A no-op on the own target, whose pool is checked
 * against the build instead.
 * @returns the block read, or undefined on the own target
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
