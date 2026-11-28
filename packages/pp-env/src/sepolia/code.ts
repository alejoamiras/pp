import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import {
	type Address,
	bytesToHex,
	type ContractFunctionName,
	createPublicClient,
	encodeAbiParameters,
	getAddress,
	type Hex,
	hexToBytes,
	keccak256,
	type PublicClient,
	padHex,
	parseAbi,
	sliceHex,
} from "viem"
import { checkout } from "../env/checkout.ts"
import { FIXTURES_DIR } from "../env/deploy.ts"
import { assertCanonicalPoseidon, assertSepolia } from "./chain.ts"
import type { CodeMatch, PoolCodeTargets, SepoliaChainId } from "./types.ts"
import { readTransport } from "./wallet.ts"

type Range = { start: number; length: number }
type Ranges = readonly Range[]
/** A forge artifact's `deployedBytecode`. */
export type DeployedBytecode = {
	object: string
	linkReferences: Record<string, Record<string, Ranges>>
	immutableReferences?: Record<string, Ranges>
}
export type Link = { file: string; name: string; address: Address }
type Artifact = { deployedBytecode?: DeployedBytecode; methodIdentifiers?: Record<string, string> }

/** solc's key for a library's own address, written at deploy so a direct call can be refused. */
const LIBRARY_SELF = "library_deploy_address"
const UNLINKED = /__\$[0-9a-f]{34}\$__/g

/**
 * A library's own-address slot must hold `self`, and every reference of one immutable the same bytes,
 * since a getter reads only one of them.
 */
function immutableFault(refs: Record<string, Ranges>, held: (r: Range) => Hex, self: Address): string | undefined {
	const selfSlot = (refs[LIBRARY_SELF] ?? []).find((r) => held(r) !== padHex(self.toLowerCase() as Hex))
	if (selfSlot) return `the library's own-address slot at byte ${selfSlot.start} does not hold ${self}`
	const split = Object.entries(refs).find(([, ranges]) => new Set(ranges.map(held)).size > 1)
	return split && `immutable ${split[0]} holds different values at its references`
}

/**
 * Compares deployed runtime code at `self` with its build. Immutable and link slots take the deployed
 * bytes, under `immutableFault`'s rules; every other byte must match.
 * @returns the libraries the code links, read from the deployed bytes, or where it first differs
 */
export function matchRuntime(build: DeployedBytecode, code: Hex, self: Address): { links: Link[] } | { mismatch: string } {
	const want = hexToBytes(build.object.toLowerCase().replace(UNLINKED, "0".repeat(40)) as Hex)
	const have = hexToBytes(code)
	if (want.length !== have.length) return { mismatch: `${have.length} bytes deployed, ${want.length} built` }
	const take = (r: Range) => want.set(have.subarray(r.start, r.start + r.length), r.start)
	const refs = build.immutableReferences ?? {}
	const fault = immutableFault(refs, (r) => bytesToHex(have.subarray(r.start, r.start + r.length)), self)
	if (fault) return { mismatch: fault }
	for (const ranges of Object.values(refs)) for (const r of ranges) take(r)
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
/** Deploy.s.sol's CANONICAL_ERC5564_ANNOUNCER, which the deploy wires into the relay on any chain that hosts it. */
const CANONICAL_ANNOUNCER: Address = "0x55649E01B5Df198D18D95b5cc5051630cfD45564"
const VERIFIERS = "VerifierArtifacts.sol"
const VAULT_ABI = parseAbi([
	"function depositVerifier() view returns (address)",
	"function ragequitVerifier() view returns (address)",
	"function verifiers(bytes32 key) view returns ((address addr, bytes4 selector))",
])
const IMMUTABLE_ABI = parseAbi([
	"function ACCESS_ROUTER() view returns (address)",
	"function proxiableUUID() view returns (bytes32)",
	"function POOL() view returns (address)",
	"function ENTRYPOINT() view returns (address)",
	"function ANNOUNCER() view returns (address)",
])
type Pin = { getter: ContractFunctionName<typeof IMMUTABLE_ABI>; want: Hex }
type Pins = Readonly<Record<string, readonly Pin[]>>
const SHAPES = [1, 2, 3, 4, 5].flatMap((n) => [1, 2, 3, 4, 5].map((m) => [n, m] as const))

/**
 * Every immutable each build carries, as the getter that reads it and what it must return. The UUPS
 * implementations hold the access router and OpenZeppelin's `__self`; `proxiableUUID` answers only
 * when `__self` is the address it is called at.
 */
function immutablePins(d: PoolCodeTargets): Pins {
	const uups: readonly Pin[] = [
		{ getter: "ACCESS_ROUTER", want: d.accessRouter },
		{ getter: "proxiableUUID", want: IMPLEMENTATION_SLOT },
	]
	return {
		Keystore: uups,
		ASPRegistry: uups,
		PoolVault: uups,
		Entrypoint: uups,
		PrivacyPoolRelay: [
			{ getter: "POOL", want: d.pool },
			{ getter: "ENTRYPOINT", want: d.entrypoint },
			{ getter: "ANNOUNCER", want: CANONICAL_ANNOUNCER },
		],
	}
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]

/** Every runtime code check at one block, each build at each address once. */
class CodeChecker {
	readonly matches: CodeMatch[] = []
	private readonly seen = new Set<string>()
	private readonly artifacts = new Map<string, Promise<Artifact>>()
	private readonly client: PublicClient
	private readonly out: string
	private readonly blockNumber: bigint
	private readonly pins: Pins
	constructor(client: PublicClient, out: string, blockNumber: bigint, pins: Pins) {
		this.client = client
		this.out = out
		this.blockNumber = blockNumber
		this.pins = pins
	}

	/**
	 * `address` holds `name` from `<out>/<file>` with its immutables pinned, and so does every library it
	 * links. An address already checked as another build is compared again.
	 */
	async contract(name: string, address: Address, file = `${name}.sol`, out = this.out): Promise<void> {
		const path = join(out, file, `${name}.json`)
		const key = `${address.toLowerCase()} ${path}`
		if (this.seen.has(key)) return
		this.seen.add(key)
		const code = await this.client.getCode({ address, blockNumber: this.blockNumber })
		if (!code || code === "0x") throw new Error(`${name} at ${address} has no code`)
		const build = await this.build(path)
		const result = matchRuntime(build, code, address)
		if ("mismatch" in result) throw new Error(`${name} at ${address} is not the build's: ${result.mismatch}`)
		await this.immutables(name, address, build)
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

	/** The vault's deposit and ragequit verifiers, and each transact route's verifier and the selector it calls. */
	async verifiers(pool: Address): Promise<void> {
		const read = { address: pool, abi: VAULT_ABI, blockNumber: this.blockNumber } as const
		await this.contract("DepositVerifier", await this.client.readContract({ ...read, functionName: "depositVerifier" }), VERIFIERS)
		await this.contract("RagequitVerifier", await this.client.readContract({ ...read, functionName: "ragequitVerifier" }), VERIFIERS)
		for (const [n, m] of SHAPES) {
			const name = `Transact${n}x${m}Verifier`
			const key = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(n), BigInt(m)]))
			const { addr, selector } = await this.client.readContract({ ...read, functionName: "verifiers", args: [key] })
			await this.contract(name, addr, VERIFIERS)
			const want = await this.verifySelector(join(this.out, VERIFIERS, `${name}.json`), name)
			if (selector.toLowerCase() !== want)
				throw new Error(`the vault routes ${n}x${m} proofs to selector ${selector}; ${name}'s verify function is ${want}`)
		}
	}

	private async immutables(name: string, address: Address, build: DeployedBytecode): Promise<void> {
		const pins = this.pins[name] ?? []
		const ids = Object.keys(build.immutableReferences ?? {}).filter((id) => id !== LIBRARY_SELF)
		if (ids.length !== pins.length) throw new Error(`${name} carries ${ids.length} immutables and ${pins.length} are pinned`)
		for (const { getter, want } of pins) {
			const got = await this.client
				.readContract({ address, abi: IMMUTABLE_ABI, functionName: getter, blockNumber: this.blockNumber })
				.catch((e: unknown) => {
					throw new Error(`${name} at ${address}: ${getter}() fails: ${firstLine(e)}`)
				})
			if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`${name} at ${address}: ${getter}() is ${got}, not ${want}`)
		}
	}

	/** The build's one `verifyProof` selector. */
	private async verifySelector(path: string, name: string): Promise<string> {
		const ids = Object.entries((await this.artifact(path)).methodIdentifiers ?? {}).filter(([sig]) => sig.startsWith("verifyProof("))
		const [only] = ids
		if (!only || ids.length !== 1) throw new Error(`${name}'s build has ${ids.length} verifyProof functions, not one`)
		return `0x${only[1].toLowerCase()}`
	}

	private async build(path: string): Promise<DeployedBytecode> {
		const artifact = await this.artifact(path)
		if (!artifact.deployedBytecode?.object) throw new Error(`${path} has no deployed bytecode`)
		return artifact.deployedBytecode
	}

	private artifact(path: string): Promise<Artifact> {
		let a = this.artifacts.get(path)
		if (!a) {
			a = readFile(path, "utf8").then((s) => JSON.parse(s) as Artifact)
			this.artifacts.set(path, a)
		}
		return a
	}
}

/**
 * The checks `verifyPoolCode` makes after its chain and Poseidon checks, against the pool's build in
 * `outs.pool` and pp-env's test token in `outs.fixtures`.
 */
export async function checkPoolCode(
	client: PublicClient,
	d: PoolCodeTargets,
	blockNumber: bigint,
	outs: { pool: string; fixtures: string },
): Promise<CodeMatch[]> {
	const check = new CodeChecker(client, outs.pool, blockNumber, immutablePins(d))
	await check.contract("AccessRouter", d.accessRouter)
	await check.contract("PrivacyPoolRelay", d.relay)
	await check.proxy("Keystore", d.keystore)
	await check.proxy("ASPRegistry", d.aspRegistry)
	await check.proxy("PoolVault", d.pool)
	await check.proxy("Entrypoint", d.entrypoint)
	await check.verifiers(d.pool)
	await check.contract("TestToken", d.asset, "TestToken.sol", outs.fixtures)
	return check.matches
}

/**
 * Compares, at one block, the runtime code of every contract the pool deploy produced with the fetched
 * build: each ERC-1967 proxy and the implementation its slot names, the relay, the access router, all
 * 27 verifiers the vault routes to and each transact route's selector, every library they link,
 * recursively, and the test token against pp-env's build; the canonical Poseidon libraries against
 * their published code. Immutables are masked in the comparison, then each is read through its getter
 * and must hold the targets' access router, vault or entrypoint, the canonical ERC-5564 announcer, or
 * the implementation's own address. Everything else must match exactly.
 * @returns every address checked, in order
 * @throws Error naming the first contract that differs, has no code or holds another immutable, or a
 * chain other than 11155111
 */
export async function verifyPoolCode(o: { rpcUrl: string; chainId: SepoliaChainId; deployment: PoolCodeTargets }): Promise<CodeMatch[]> {
	const client = createPublicClient({ transport: readTransport(o.rpcUrl) })
	await assertSepolia(client, o.chainId)
	const co = checkout()
	const blockNumber = await client.getBlockNumber()
	const poseidon = await assertCanonicalPoseidon(client, co, blockNumber)
	const outs = { pool: join(co.contracts, "out"), fixtures: join(FIXTURES_DIR, "out") }
	return [...poseidon, ...(await checkPoolCode(client, o.deployment, blockNumber, outs))]
}
