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

const EIP1967_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
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

export type BlockTag = bigint | "finalized"
const tagOf = (b: BlockTag) => (b === "finalized" ? b : numberToHex(b))

/** Every binding in {@link Bindings}, read at one block. */
export async function readBindings(rpc: Rpc, pins: Pins, block: BlockTag): Promise<Bindings> {
	const tag = tagOf(block)
	const { vault } = pins.pool
	const vaultImplementation = addressWord(await rpc<Hex>("eth_getStorageAt", [vault, EIP1967_IMPLEMENTATION, tag]))
	const route = await rpc<Hex>("eth_getStorageAt", [vault, routeSlot(1n, 1n), tag])
	const transact1x1Verifier = addressWord(route)
	const rollup = addressWord(await call(rpc, pins.aztec.registry, "getCanonicalRollup()", tag))
	const inbox = addressWord(await call(rpc, rollup, "getInbox()", tag))
	return {
		vaultImplementation,
		vaultImplementationCodeHash: await codeHash(rpc, vaultImplementation, tag),
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

/** Names of the bindings in `got` that differ from `want`. */
export function drifted(got: Bindings, want: Bindings): string[] {
	return (Object.keys(want) as (keyof Bindings)[]).filter((k) => !same(got[k], want[k]))
}

const explain = (names: string[], got: Bindings, want: Bindings) =>
	names.map((k) => `${k} is ${got[k as keyof Bindings]}, pinned ${want[k as keyof Bindings]}`).join("; ")

type Header = { hash: Hex } | null

/**
 * The endpoint itself, before anything forks from it: it serves Sepolia, the pinned block's header with
 * the pinned hash, and state at that block (pruned archive state is the usual way a free endpoint fails).
 */
export async function checkEndpoint(rpc: Rpc, pins: Pins, host: string): Promise<void> {
	const n = pins.block.number
	const unserved = (why: unknown) =>
		new PreflightError("endpoint", `${host} no longer serves block ${n}: ${why instanceof Error ? why.message : String(why)}`)
	let chainId: number
	let header: Header
	try {
		chainId = Number(await rpc<Hex>("eth_chainId"))
		header = await rpc<Header>("eth_getBlockByNumber", [numberToHex(n), false])
		await rpc<Hex>("eth_getStorageAt", [pins.pool.vault, EIP1967_IMPLEMENTATION, numberToHex(n)])
	} catch (err) {
		throw unserved(err)
	}
	if (chainId !== SEPOLIA_CHAIN_ID) throw new PreflightError("pin", `${host} serves chain ${chainId}, not Sepolia`, ["chainId"])
	if (header === null) throw unserved("no such block")
	if (header.hash.toLowerCase() !== pins.block.hash.toLowerCase())
		throw new PreflightError("pin", `pin block.hash: ${host} has ${header.hash} at block ${n}, pinned ${pins.block.hash}`, [
			"block.hash",
		])
}

/** The fork at the pinned block holds every pin. */
export async function checkFork(fork: Rpc, pins: Pins): Promise<void> {
	const n = pins.block.number
	const header = await fork<Header>("eth_getBlockByNumber", [numberToHex(n), false])
	if (header?.hash.toLowerCase() !== pins.block.hash.toLowerCase())
		throw new PreflightError("pin", `pin block.hash: the fork has ${header?.hash} at block ${n}, pinned ${pins.block.hash}`, [
			"block.hash",
		])
	const got = await readBindings(fork, pins, n)
	const names = drifted(got, pins.bindings)
	if (names.length > 0)
		throw new PreflightError("pin", `pins drifted on the fork at block ${n}: ${explain(names, got, pins.bindings)}`, names)
}

/** The live deployment still matches the pins, read straight from the endpoint at its finalized block. */
export async function checkLive(rpc: Rpc, pins: Pins): Promise<bigint> {
	const header = await rpc<{ number: Hex }>("eth_getBlockByNumber", ["finalized", false])
	const finalized = BigInt(header.number)
	const got = await readBindings(rpc, pins, finalized)
	const names = drifted(got, pins.bindings)
	if (names.length > 0)
		throw new PreflightError(
			"live",
			`the live deployment moved after block ${pins.block.number} (finalized ${finalized}): ${explain(names, got, pins.bindings)}`,
			names,
		)
	return finalized
}
