import { BN254_P } from "@pp/bridge-spec"
import type { RootRecord } from "./snapshot"

export type Hex = `0x${string}`

/** The registry's `current` slot: `WithHash<RootRecord, 5>` keeps the five fields here, in order, then their hash. A test pins it to the artifact. */
export const ROOT_RECORD_SLOT = 4n

/** The registry's `SIZES_SLOT`, outside its declared storage: the pool list's length here, the birth list's one slot up. A test pins it to the source. */
export const SIZES_SLOT = 0x6c6973745f73697a6573n

export class RegistryAddressError extends Error {
	constructor(value: unknown) {
		super(`registry must be an AztecAddress string (0x and 64 lower-case hex digits, below p): ${String(value)}`)
		this.name = "RegistryAddressError"
	}
}

const ADDRESS = /^0x[0-9a-f]{64}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const FIELD = /^0x[0-9a-fA-F]{1,64}$/
const U64_LIMIT = 2n ** 64n
const U32_LIMIT = 2n ** 32n

type Reply<T> = { result?: T; error?: { message: string } }

const RPC_TIMEOUT_MS = 10_000

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	})
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
	const reply = (await res.json()) as Reply<T>
	if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
	return reply.result as T
}

async function blockHash(url: string, at: number | Hex | undefined): Promise<Hex> {
	let param: unknown = "latest"
	if (typeof at === "number") {
		if (!Number.isSafeInteger(at) || at < 0) throw new RangeError(`at: not a block number: ${at}`)
		param = at
	} else if (at !== undefined) {
		if (!HASH.test(at)) throw new RangeError(`at: not a block hash: ${at}`)
		param = { hash: at }
	}
	const hash = (await rpc<{ blockHash?: unknown } | null>(url, "node_getBlockData", [param]))?.blockHash
	if (typeof hash !== "string" || !HASH.test(hash)) throw new Error(`node_getBlockData: no block for ${String(at ?? "latest")}`)
	return hash as Hex
}

function decode(v: unknown, field: string, limit: bigint): bigint {
	if (typeof v !== "string" || !FIELD.test(v) || BigInt(v) >= limit)
		throw new Error(`node_getPublicStorageAt: ${field} out of range: ${String(v)}`)
	return BigInt(v)
}

/**
 * The registry's record and list lengths, keyless, by plain JSON-RPC to an Aztec node. `at` (a block
 * number or hash; default the latest block) is resolved to one block hash first, and all seven slots are
 * read at it, so the lengths are the ones posted with the roots. Throws `RegistryAddressError` before any
 * request for a malformed `registry`, an `Error` naming the JSON-RPC method on a node error or an
 * out-of-range value, and an `Error` for a pool root without a pool length (a registry that predates them).
 */
export async function readRootRecord(a: { aztecNode: string; registry: Hex; at?: number | Hex }): Promise<RootRecord> {
	if (typeof a.registry !== "string" || !ADDRESS.test(a.registry) || BigInt(a.registry) >= BN254_P)
		throw new RegistryAddressError(a.registry)
	const hash = await blockHash(a.aztecNode, a.at)
	const slots = [0n, 1n, 2n, 3n, 4n].map((i) => ROOT_RECORD_SLOT + i).concat([SIZES_SLOT, SIZES_SLOT + 1n])
	const raw = await Promise.all(
		slots.map((s) =>
			rpc<unknown>(a.aztecNode, "node_getPublicStorageAt", [{ hash }, a.registry, `0x${s.toString(16).padStart(64, "0")}`]),
		),
	)
	const record = {
		sequence: decode(raw[0], "sequence", U64_LIMIT),
		poolRoot: decode(raw[1], "poolRoot", BN254_P),
		birthRoot: decode(raw[2], "birthRoot", BN254_P),
		l1Block: decode(raw[3], "l1Block", U64_LIMIT),
		rootTime: decode(raw[4], "rootTime", U64_LIMIT),
		poolSize: decode(raw[5], "poolSize", U32_LIMIT),
		birthSize: decode(raw[6], "birthSize", U32_LIMIT),
	}
	if (record.poolRoot !== 0n && record.poolSize === 0n)
		throw new Error("readRootRecord: a pool root without a pool length: the registry predates list lengths")
	return record
}
