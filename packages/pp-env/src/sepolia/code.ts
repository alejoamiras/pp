import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import {
	type Address,
	bytesToHex,
	createPublicClient,
	encodeAbiParameters,
	getAddress,
	type Hex,
	hexToBytes,
	http,
	keccak256,
	type PublicClient,
	padHex,
	parseAbi,
	sliceHex,
} from "viem"
import { checkout } from "../env/checkout.ts"
import { assertCanonicalPoseidon, assertSepolia } from "./chain.ts"
import type { CodeMatch, PoolCodeTargets, SepoliaChainId } from "./types.ts"

type Ranges = readonly { start: number; length: number }[]
/** A forge artifact's `deployedBytecode`. */
export type DeployedBytecode = {
	object: string
	linkReferences: Record<string, Record<string, Ranges>>
	immutableReferences?: Record<string, Ranges>
}
export type Link = { file: string; name: string; address: Address }

/** solc's key for a library's own address, written at deploy so a direct call can be refused. */
const LIBRARY_SELF = "library_deploy_address"
const UNLINKED = /__\$[0-9a-f]{34}\$__/g

/**
 * Compares deployed runtime code at `self` with its build. Immutable and link slots take the deployed
 * bytes, except that a library's own-address slot must hold `self`; every other byte must match.
 * @returns the libraries the code links, read from the deployed bytes, or where it first differs
 */
export function matchRuntime(build: DeployedBytecode, code: Hex, self: Address): { links: Link[] } | { mismatch: string } {
	const want = hexToBytes(build.object.toLowerCase().replace(UNLINKED, "0".repeat(40)) as Hex)
	const have = hexToBytes(code)
	if (want.length !== have.length) return { mismatch: `${have.length} bytes deployed, ${want.length} built` }
	const take = ({ start, length }: { start: number; length: number }) => want.set(have.subarray(start, start + length), start)
	const selfSlot = (build.immutableReferences?.[LIBRARY_SELF] ?? []).find(
		(r) => bytesToHex(have.subarray(r.start, r.start + r.length)) !== padHex(self.toLowerCase() as Hex),
	)
	if (selfSlot) return { mismatch: `the library's own-address slot at byte ${selfSlot.start} does not hold ${self}` }
	for (const ranges of Object.values(build.immutableReferences ?? {})) for (const r of ranges) take(r)
	const links: Link[] = []
	for (const [file, libraries] of Object.entries(build.linkReferences))
		for (const [name, ranges] of Object.entries(libraries))
			for (const r of ranges) {
				take(r)
				links.push({ file, name, address: getAddress(sliceHex(code, r.start, r.start + r.length)) })
			}
	const at = want.findIndex((b, i) => b !== have[i])
	return at === -1 ? { links } : { mismatch: `byte ${at} differs` }
}

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const VAULT_ABI = parseAbi([
	"function depositVerifier() view returns (address)",
	"function ragequitVerifier() view returns (address)",
	"function verifiers(bytes32 key) view returns ((address addr, bytes4 selector))",
])
const SHAPES = [1, 2, 3, 4, 5].flatMap((n) => [1, 2, 3, 4, 5].map((m) => [n, m] as const))

/** Every runtime code check at one block, each library once. */
class CodeChecker {
	readonly matches: CodeMatch[] = []
	private readonly seen = new Set<string>()
	private readonly client: PublicClient
	private readonly out: string
	private readonly blockNumber: bigint
	constructor(client: PublicClient, out: string, blockNumber: bigint) {
		this.client = client
		this.out = out
		this.blockNumber = blockNumber
	}

	/** `address` holds `name` from `<file>` in the build, and so does every library it links. */
	async contract(name: string, address: Address, file = `${name}.sol`): Promise<void> {
		if (this.seen.has(address.toLowerCase())) return
		this.seen.add(address.toLowerCase())
		const code = await this.client.getCode({ address, blockNumber: this.blockNumber })
		if (!code || code === "0x") throw new Error(`${name} at ${address} has no code`)
		const build = await this.build(file, name)
		const result = matchRuntime(build, code, address)
		if ("mismatch" in result) throw new Error(`${name} at ${address} is not the build's: ${result.mismatch}`)
		this.matches.push({ name, address: getAddress(address) })
		for (const link of result.links) await this.contract(link.name, link.address, basename(link.file))
	}

	/** `address` is the build's ERC-1967 proxy and its implementation is the build's `name`. */
	async proxy(name: string, address: Address): Promise<void> {
		await this.contract("ERC1967Proxy", address)
		const slot = await this.client.getStorageAt({ address, slot: IMPLEMENTATION_SLOT, blockNumber: this.blockNumber })
		if (!slot) throw new Error(`${name}'s proxy at ${address} has no implementation slot`)
		await this.contract(name, getAddress(sliceHex(slot, 12)))
	}

	async verifiers(pool: Address): Promise<void> {
		const read = { address: pool, abi: VAULT_ABI, blockNumber: this.blockNumber } as const
		await this.contract(
			"DepositVerifier",
			await this.client.readContract({ ...read, functionName: "depositVerifier" }),
			"VerifierArtifacts.sol",
		)
		await this.contract(
			"RagequitVerifier",
			await this.client.readContract({ ...read, functionName: "ragequitVerifier" }),
			"VerifierArtifacts.sol",
		)
		for (const [n, m] of SHAPES) {
			const key = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(n), BigInt(m)]))
			const { addr } = await this.client.readContract({ ...read, functionName: "verifiers", args: [key] })
			await this.contract(`Transact${n}x${m}Verifier`, addr, "VerifierArtifacts.sol")
		}
	}

	private async build(file: string, name: string): Promise<DeployedBytecode> {
		const path = join(this.out, file, `${name}.json`)
		const artifact = JSON.parse(await readFile(path, "utf8")) as { deployedBytecode?: DeployedBytecode }
		if (!artifact.deployedBytecode?.object) throw new Error(`${path} has no deployed bytecode`)
		return artifact.deployedBytecode
	}
}

/**
 * Compares, at one block, the runtime code of every contract the pool deploy produced with the fetched
 * build: each ERC-1967 proxy and the implementation its slot names, the relay, the access router, all
 * 27 verifiers the vault routes to, and every library they link, recursively; the canonical Poseidon
 * libraries against their published code. Immutables are masked; everything else must match exactly.
 * @returns every address checked, in order
 * @throws Error naming the first contract that differs or has no code, or a chain other than 11155111
 */
export async function verifyPoolCode(o: { rpcUrl: string; chainId: SepoliaChainId; deployment: PoolCodeTargets }): Promise<CodeMatch[]> {
	const client = createPublicClient({ transport: http(o.rpcUrl) })
	await assertSepolia(client, o.chainId)
	const co = checkout()
	const blockNumber = await client.getBlockNumber()
	const poseidon = await assertCanonicalPoseidon(client, co, blockNumber)
	const d = o.deployment
	const check = new CodeChecker(client, join(co.contracts, "out"), blockNumber)
	await check.contract("AccessRouter", d.accessRouter)
	await check.contract("PrivacyPoolRelay", d.relay)
	await check.proxy("Keystore", d.keystore)
	await check.proxy("ASPRegistry", d.aspRegistry)
	await check.proxy("PoolVault", d.pool)
	await check.proxy("Entrypoint", d.entrypoint)
	await check.verifiers(d.pool)
	return [...poseidon, ...check.matches]
}
