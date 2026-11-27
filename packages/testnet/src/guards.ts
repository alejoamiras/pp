/**
 * The checks every testnet CLI runs before it reads a key. They keep a key from being used, not from
 * being present: env-exec puts every value of a run's template into the environment before Bun starts.
 */
import { type Address, type Hex, isAddressEqual, isHex } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { isPinned, LOCAL, MAINNET, SEPOLIA } from "./network"
import type { TestnetDeployment } from "./schema"

/** Where a run signs: the public chains, the local stack, or a loopback fork of Sepolia this run started. */
export type Mode = { kind: "live" } | { kind: "rehearse"; manifest: string } | { kind: "rehearse-fork"; url: string }

/** Refusals carry the guard's name, so a caller and a test can tell which check stopped the run. */
export class GuardError extends Error {
	override readonly name = "GuardError"
	constructor(
		readonly guard: string,
		detail: string,
	) {
		super(`${guard}: ${detail}`)
	}
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const isLoopback = (u: string) => URL.canParse(u) && new URL(u).protocol === "http:" && LOOPBACK.has(new URL(u).hostname)

/** The chain every guard of `mode` expects. */
export const chainOf = (mode: Mode): number => (mode.kind === "rehearse" ? LOCAL : SEPOLIA)

/**
 * Live: the file's L1 and node URLs are pinned and its chain is Sepolia. Rehearse: chain 31337 on
 * loopback. Rehearse-fork: Sepolia's id on the loopback anvil named in argv (the fork-node guard, which
 * checks its owner and version, runs where the fork is used).
 * @throws GuardError `transport`
 */
export function assertTransport(d: TestnetDeployment, mode: Mode, usesL2: boolean): void {
	const n = d.network
	if (n.l1ChainId !== chainOf(mode))
		throw new GuardError("transport", `the file names chain ${n.l1ChainId}, this mode signs on ${chainOf(mode)}`)
	if (mode.kind === "live") {
		if (!isPinned("l1Rpc", n.l1Rpc)) throw new GuardError("transport", `${n.l1Rpc} is not a pinned L1 URL`)
		if (!isPinned("aztecNode", n.aztecNode)) throw new GuardError("transport", `${n.aztecNode} is not a pinned node URL`)
		return
	}
	if (mode.kind === "rehearse-fork" && (n.l1Rpc !== mode.url || !isLoopback(mode.url)))
		throw new GuardError("transport", `a fork rehearsal signs only on the loopback anvil it started, not ${n.l1Rpc}`)
	if (mode.kind === "rehearse" && !isLoopback(n.l1Rpc))
		throw new GuardError("transport", `a rehearsal's L1 must be loopback, not ${n.l1Rpc}`)
	if (usesL2 && mode.kind === "rehearse" && !isLoopback(n.aztecNode))
		throw new GuardError("transport", `a rehearsal's node must be loopback, not ${n.aztecNode}`)
}

/**
 * The endpoint's chain id is the mode's; mainnet is refused by name first.
 * @throws GuardError `chain`
 */
export async function assertL1Chain(l1: { getChainId(): Promise<number> }, mode: Mode): Promise<void> {
	const id = await l1.getChainId()
	if (id === MAINNET) throw new GuardError("chain", "the endpoint is Ethereum mainnet; testnet runs never sign there")
	if (id !== chainOf(mode)) throw new GuardError("chain", `the endpoint serves chain ${id}, not ${chainOf(mode)}`)
}

type NodeInfoLike = {
	l1ChainId: number
	rollupVersion: number
	l1ContractAddresses: Record<"rollupAddress" | "registryAddress" | "inboxAddress" | "outboxAddress", { toString(): string }>
}

/**
 * The Aztec node follows the file's rollup: its L1 chain, version and the four L1 contracts.
 * @throws GuardError `node`
 */
export async function assertNode(node: { getNodeInfo(): Promise<NodeInfoLike> }, d: TestnetDeployment): Promise<void> {
	const info = await node.getNodeInfo()
	const n = d.network
	const same = (name: string, got: string, want: Address) => {
		if (!isAddressEqual(got as Address, want)) throw new GuardError("node", `${name} is ${got}, the file names ${want}`)
	}
	if (info.l1ChainId !== n.l1ChainId) throw new GuardError("node", `the node follows chain ${info.l1ChainId}, not ${n.l1ChainId}`)
	if (info.rollupVersion !== n.rollupVersion) throw new GuardError("node", `rollup version ${info.rollupVersion}, not ${n.rollupVersion}`)
	const a = info.l1ContractAddresses
	same("rollup", a.rollupAddress.toString(), n.rollup)
	same("registry", a.registryAddress.toString(), n.l1Registry)
	same("inbox", a.inboxAddress.toString(), n.inbox)
	same("outbox", a.outboxAddress.toString(), n.outbox)
}

/** A rehearsal must not be able to reach a real key, so one set in its environment stops it. */
export function assertNoTestnetKeys(env: NodeJS.ProcessEnv): void {
	const set = Object.keys(env).filter((k) => k.startsWith("PP_TESTNET_"))
	if (set.length) throw new GuardError("keys", `a rehearsal refuses real-key variables in its environment: ${set.join(", ")}`)
}

/** Anvil's well-known accounts, the only L1 keys a local rehearsal accepts. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
const ANVIL_ACCOUNTS = 32

let anvilAddresses: Set<string> | undefined
const isAnvilKey = (address: Address) => {
	anvilAddresses ??= new Set(
		Array.from({ length: ANVIL_ACCOUNTS }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address.toLowerCase()),
	)
	return anvilAddresses.has(address.toLowerCase())
}

/** A key's role decides how it is checked; L2 secrets are field elements, L1 keys 32-byte private keys. */
export type KeySpec = { name: string; kind: "l1" | "l2" }

/**
 * Reads exactly `specs` from the environment: `PP_TESTNET_<name>` live, `PP_REHEARSE_<name>` in a
 * rehearsal. On the local stack an L1 key must be one of anvil's; on a fork the rehearsal generated it.
 * @throws GuardError `keys` naming the first missing or malformed variable, never its value
 */
export function readKeys(
	specs: readonly KeySpec[],
	mode: Mode,
	env: NodeJS.ProcessEnv,
	addressOf: (key: Hex) => Address,
): Record<string, Hex> {
	if (mode.kind !== "live") assertNoTestnetKeys(env)
	const prefix = mode.kind === "live" ? "PP_TESTNET_" : "PP_REHEARSE_"
	const out: Record<string, Hex> = {}
	for (const { name, kind } of specs) {
		const variable = `${prefix}${name}`
		const v = env[variable]
		if (v === undefined || !isHex(v) || v.length !== 66)
			throw new GuardError("keys", `${variable} is not set to a 32-byte 0x hex value`)
		if (kind === "l1" && mode.kind === "rehearse" && !isAnvilKey(addressOf(v)))
			throw new GuardError("keys", `${variable} is not one of anvil's well-known keys`)
		out[name] = v
	}
	return out
}
