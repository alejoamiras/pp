import {
	type Address,
	concatHex,
	encodeAbiParameters,
	getAddress,
	type Hex,
	hexToBigInt,
	keccak256,
	numberToHex,
	slice,
	toFunctionSelector,
} from "viem"
import {
	type CodeReader,
	type ContractCode,
	codeMismatches,
	EIP1967_IMPLEMENTATION_SLOT,
	EMPTY_CODE_HASH,
	POOL_CONTRACTS,
	type PoolCode,
	type PoolContract,
	readPoolCode,
} from "./code.ts"
import { missingKeyPoints, type Vkey } from "./keys.ts"
import { type Bindings, type Pins, SEPOLIA_CHAIN_ID } from "./pins.ts"
import type { Rpc } from "./rpc.ts"

/**
 * Why a run cannot go on, kept apart because each asks for a different response: `endpoint` (it no longer
 * serves the pinned block: change endpoints), `pin` (what the run reads differs from a pin: the endpoint
 * or the fork is wrong), `live` (the deployment moved after the pinned block: refresh the pins).
 */
export class PreflightError extends Error {
	readonly kind: "endpoint" | "pin" | "live"
	readonly pins: readonly string[]
	constructor(kind: PreflightError["kind"], message: string, pins: readonly string[] = []) {
		super(message)
		this.name = "PreflightError"
		this.kind = kind
		this.pins = pins
	}
}

/** The vault's ERC-7201 router storage; its first slot maps keccak256(abi.encode(inputs, outputs)) to a packed route. */
const ROUTER_LOCATION = "0x0c027be59f417c97b0d67624f8bfbaef96df39bc0b10e77a5d17c62359798400"

function routeSlot(inputs: bigint, outputs: bigint): Hex {
	const key = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [inputs, outputs]))
	return keccak256(concatHex([key, ROUTER_LOCATION]))
}

const call = (rpc: Rpc, to: Address, signature: string, tag: string) =>
	rpc<Hex>("eth_call", [{ to, data: toFunctionSelector(signature) }, tag])
const addressWord = (word: Hex): Address => getAddress(slice(word, 12, 32))
const codeHash = async (rpc: Rpc, address: Address, tag: string) => keccak256(await rpc<Hex>("eth_getCode", [address, tag]))

/** This transport as the shared reader takes it. Every read names the block; the transport must serve that height, never its head. */
const codeReader = (rpc: Rpc): CodeReader => ({
	getCode: ({ address, blockNumber }) => rpc<Hex>("eth_getCode", [address, numberToHex(blockNumber)]),
	getStorageAt: ({ address, slot, blockNumber }) => rpc<Hex>("eth_getStorageAt", [address, slot, numberToHex(blockNumber)]),
})

/** Every binding in {@link Bindings}, read at one block; `code`, when given, must have been read at that block. */
export async function readBindings(rpc: Rpc, pins: Pins, block: bigint, code?: PoolCode): Promise<Bindings> {
	const tag = numberToHex(block)
	const { vault } = pins.pool
	const route = await rpc<Hex>("eth_getStorageAt", [vault, routeSlot(1n, 1n), tag])
	const transact1x1Verifier = addressWord(route)
	const rollup = addressWord(await call(rpc, pins.aztec.registry, "getCanonicalRollup()", tag))
	const inbox = addressWord(await call(rpc, rollup, "getInbox()", tag))
	return {
		code: code ?? (await readPoolCode(codeReader(rpc), pins.pool, block)),
		depositVerifier: addressWord(await call(rpc, vault, "depositVerifier()", tag)),
		transact1x1Verifier,
		transact1x1Selector: slice(route, 8, 12),
		transact1x1VerifierCodeHash: await codeHash(rpc, transact1x1Verifier, tag),
		rollup,
		rollupVersion: hexToBigInt(await call(rpc, rollup, "getVersion()", tag)),
		inbox,
		inboxCodeHash: await codeHash(rpc, inbox, tag),
		outbox: addressWord(await call(rpc, rollup, "getOutbox()", tag)),
	}
}

const same = (a: unknown, b: unknown): boolean =>
	typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b

/** Names of the bindings in `got` that differ from `want`; a code field is named `code.<contract>.<field>`. */
export function drifted(got: Bindings, want: Bindings): string[] {
	const flat = (Object.keys(want) as (keyof Bindings)[]).filter((k) => k !== "code" && !same(got[k], want[k]))
	return [...flat, ...codeMismatches(want.code, got.code)]
}

const at = (b: Bindings, name: string): unknown =>
	name.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], b)

export type Mismatch = { name: string; message: string }

const explain = (names: string[], got: Bindings, want: Bindings): Mismatch[] =>
	names.map((name) => ({ name, message: `${name} is ${at(got, name)}, pinned ${at(want, name)}` }))

/**
 * Each contract names the others the target pins, so the code the pins hash is the code a spend reaches.
 * Checked against the target's addresses rather than pinned, so a refresh can never enroll a rewiring.
 */
export async function wiringMismatches(rpc: Rpc, pins: Pins, block: bigint): Promise<Mismatch[]> {
	const tag = numberToHex(block)
	const { vault, entrypoint, keystore, aspRegistry } = pins.pool
	const links = [
		["wiring.vault.keystore", vault, "keystore()", keystore],
		["wiring.vault.aspRegistry", vault, "aspRegistry()", aspRegistry],
		["wiring.entrypoint.poolVault", entrypoint, "poolVault()", vault],
	] as const
	const out: Mismatch[] = []
	for (const [name, from, getter, want] of links) {
		const got = addressWord(await call(rpc, from, getter, tag))
		if (!same(got, want)) out.push({ name, message: `${name} is ${got}, the target's is ${want}` })
	}
	return out
}

async function mismatchesAt(rpc: Rpc, pins: Pins, block: bigint): Promise<Mismatch[]> {
	// Code first and alone: an upgrade can drop a getter the other reads call, and must still fail as an upgrade.
	const code = await readPoolCode(codeReader(rpc), pins.pool, block)
	const moved = codeMismatches(pins.bindings.code, code)
	if (moved.length > 0) return explain(moved, { ...pins.bindings, code }, pins.bindings)
	const got = await readBindings(rpc, pins, block, code)
	return [...explain(drifted(got, pins.bindings), got, pins.bindings), ...(await wiringMismatches(rpc, pins, block))]
}

const fail = (kind: PreflightError["kind"], lead: string, found: Mismatch[]) =>
	new PreflightError(
		kind,
		`${lead}: ${found.map((m) => m.message).join("; ")}`,
		found.map((m) => m.name),
	)

type Header = { hash: Hex } | null

/**
 * The endpoint itself, before anything forks from it: it serves Sepolia, the pinned block's header with
 * the pinned hash, and state at that block (pruned archive state is the usual way a free endpoint fails).
 */
export async function checkEndpoint(rpc: Rpc, pins: Pins, host: string): Promise<void> {
	const n = pins.block.number
	const unserved = (why: unknown) =>
		new PreflightError("endpoint", `${host} no longer serves block ${n}: ${why instanceof Error ? why.message : String(why)}`)
	const served = <T>(read: Promise<T>) => read.catch((err: unknown) => Promise.reject(unserved(err)))
	// Identity first, so another chain or block is named as such even where state is missing too.
	const chainId = Number(await served(rpc<Hex>("eth_chainId")))
	if (chainId !== SEPOLIA_CHAIN_ID) throw new PreflightError("pin", `${host} serves chain ${chainId}, not Sepolia`, ["chainId"])
	const header = await served(rpc<Header>("eth_getBlockByNumber", [numberToHex(n), false]))
	if (header === null) throw unserved("no such block")
	if (header.hash.toLowerCase() !== pins.block.hash.toLowerCase())
		throw new PreflightError("pin", `pin block.hash: ${host} has ${header.hash} at block ${n}, pinned ${pins.block.hash}`, [
			"block.hash",
		])
	await served(rpc<Hex>("eth_getStorageAt", [pins.pool.vault, EIP1967_IMPLEMENTATION_SLOT, numberToHex(n)]))
}

/** The fork at the pinned block holds every pin. */
export async function checkFork(fork: Rpc, pins: Pins): Promise<void> {
	const n = pins.block.number
	const header = await fork<Header>("eth_getBlockByNumber", [numberToHex(n), false])
	if (header?.hash.toLowerCase() !== pins.block.hash.toLowerCase())
		throw new PreflightError("pin", `pin block.hash: the fork has ${header?.hash} at block ${n}, pinned ${pins.block.hash}`, [
			"block.hash",
		])
	const found = await mismatchesAt(fork, pins, n)
	if (found.length > 0) throw fail("pin", `pins drifted on the fork at block ${n}`, found)
}

/** The pinned verifier that checks each circuit's proofs. */
export const VERIFIER_OF = { deposit: "depositVerifier", transact_1x1: "transact1x1Verifier" } as const
export type BundleVkeys = Record<keyof typeof VERIFIER_OF, Vkey>

/** The pinned verifiers on the fork embed the bundle's keys, so a proof from the bundle can verify there. */
export async function checkKeys(fork: Rpc, pins: Pins, vkeys: BundleVkeys): Promise<void> {
	const tag = numberToHex(pins.block.number)
	const names: string[] = []
	const reasons: string[] = []
	for (const [circuit, binding] of Object.entries(VERIFIER_OF) as [keyof BundleVkeys, (typeof VERIFIER_OF)[keyof BundleVkeys]][]) {
		const lacks = missingKeyPoints(await fork<Hex>("eth_getCode", [pins.bindings[binding], tag]), vkeys[circuit])
		if (lacks.length === 0) continue
		names.push(`${binding}.keys`)
		reasons.push(`${binding} lacks the ${circuit} key's ${lacks.join(", ")}`)
	}
	if (names.length > 0)
		throw new PreflightError("pin", `the pinned verifiers do not hold the bundle's keys: ${reasons.join("; ")}`, names)
}

/** The live deployment still matches the pins, read straight from the endpoint at its finalized block. */
export async function checkLive(rpc: Rpc, pins: Pins): Promise<bigint> {
	const unread = (why: unknown) =>
		new PreflightError(
			"endpoint",
			`the endpoint failed reading the live deployment: ${why instanceof Error ? why.message : String(why)}`,
		)
	let finalized: bigint
	let found: Mismatch[]
	try {
		const header = await rpc<{ number: Hex } | null>("eth_getBlockByNumber", ["finalized", false])
		if (header === null) throw new Error("no finalized block")
		finalized = BigInt(header.number)
		// A lagging gateway would otherwise check the deployment before the pin, not after it.
		if (finalized < pins.block.number) throw new Error(`its finalized block ${finalized} predates the pinned block`)
		found = await mismatchesAt(rpc, pins, finalized)
	} catch (err) {
		throw unread(err)
	}
	if (found.length > 0) throw fail("live", `the live deployment moved after block ${pins.block.number} (finalized ${finalized})`, found)
	return finalized
}

/** Why one contract's code could never be a valid pin; a proxy other than the pinned one needs its dispatch reviewed first. */
function codeProblems(c: PoolContract, got: ContractCode, pinned: ContractCode): string[] {
	if (got.proxyCodeHash === EMPTY_CODE_HASH) return [`${c} has no code`]
	if (!same(got.proxyCodeHash, pinned.proxyCodeHash))
		return [`${c} runs proxy code ${got.proxyCodeHash}, pinned ${pinned.proxyCodeHash}; review its dispatch before pinning it`]
	if (BigInt(got.implementation) === 0n) return [`${c}'s EIP-1967 slot is empty`]
	if (got.implementationCodeHash === EMPTY_CODE_HASH) return [`${c}'s implementation ${got.implementation} has no code`]
	return []
}

/**
 * The bindings to pin for `pins`' addresses at `block`, refused when the result could never be a valid pin:
 * an unfinalized block, empty code, a cleared slot or route, a changed proxy, or wiring that names other
 * contracts than the target's.
 */
export async function enroll(rpc: Rpc, pins: Pins, block: bigint): Promise<Bindings> {
	const finalized = await rpc<{ number: Hex } | null>("eth_getBlockByNumber", ["finalized", false])
	// A block that can still reorg could pair its hash with another block's state.
	if (finalized === null || block > BigInt(finalized.number)) throw new Error(`refusing to pin block ${block}: it is not finalized`)
	const bindings = await readBindings(rpc, pins, block)
	const problems = [
		...(await wiringMismatches(rpc, pins, block)).map((m) => m.message),
		...POOL_CONTRACTS.flatMap((c) => codeProblems(c, bindings.code[c], pins.bindings.code[c])),
		...(["transact1x1VerifierCodeHash", "inboxCodeHash"] as const)
			.filter((k) => bindings[k] === EMPTY_CODE_HASH)
			.map((k) => `${k} is the hash of empty code`),
	]
	if (problems.length > 0) throw new Error(`refusing to pin block ${block}: ${problems.join("; ")}`)
	return bindings
}
