/** The checks every testnet CLI runs before it reads a key, and the one place that reads keys. */
import { readFileSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname } from "node:path"
import { parseStackManifest } from "@pp/bridge-core"
import { ANVIL_CLIENT_VERSION } from "@pp/sepolia-fork/anvil"
import { type Address, type Hex, isAddressEqual } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { GuardError } from "./errors"
import { isKeyValue, type KeySpec, keyFilePath, loadKeys } from "./keyfile"
import { isPinned, LOCAL, MAINNET, SEPOLIA } from "./network"
import { remember } from "./redact"
import type { TestnetDeployment } from "./schema"

export { GuardError } from "./errors"
export type { KeySpec } from "./keyfile"

/** Where a run signs: the public chains, the local stack, or a loopback fork of Sepolia this run started. */
export type Mode = { kind: "live" } | { kind: "rehearse"; manifest: string } | { kind: "rehearse-fork"; url: string }

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const isLoopback = (u: string) => URL.canParse(u) && new URL(u).protocol === "http:" && LOOPBACK.has(new URL(u).hostname)

/** The chain every guard of `mode` expects. */
export const chainOf = (mode: Mode): number => (mode.kind === "rehearse" ? LOCAL : SEPOLIA)

/**
 * The file's endpoints are the mode's. Live: pinned URLs on Sepolia, a send endpoint required. A
 * rehearsal's send endpoint, when it names one, is loopback. Rehearse: chain 31337 on loopback,
 * at exactly the L1 and node URLs of the stack manifest named in argv. Rehearse-fork: Sepolia's id on
 * the loopback URL named in argv, for L1 commands only: a fork has no Aztec node of its own, so an L2
 * command would reach the real testnet. That the URL serves the pinned anvil is {@link assertForkNode}'s
 * check, which needs the network.
 * @throws GuardError `transport`
 */
export function assertTransport(d: TestnetDeployment, mode: Mode, usesL2: boolean): void {
	const n = d.network
	if (n.l1ChainId !== chainOf(mode))
		throw new GuardError("transport", `the file names chain ${n.l1ChainId}, this mode signs on ${chainOf(mode)}`)
	if (mode.kind === "live") {
		assertPinned(n)
		return
	}
	if (n.l1SendRpc !== undefined && !isLoopback(n.l1SendRpc))
		throw new GuardError("transport", `a rehearsal's L1 send endpoint must be loopback, not ${n.l1SendRpc}`)
	if (mode.kind === "rehearse-fork") {
		if (usesL2)
			throw new GuardError(
				"transport",
				"a fork rehearsal has no Aztec node of its own; L2 commands rehearse on the local stack with --rehearse",
			)
		if (n.l1Rpc !== mode.url || !isLoopback(mode.url))
			throw new GuardError("transport", `a fork rehearsal signs only on the loopback anvil it started, not ${n.l1Rpc}`)
		return
	}
	if (!isLoopback(n.l1Rpc)) throw new GuardError("transport", `a rehearsal's L1 must be loopback, not ${n.l1Rpc}`)
	if (usesL2 && !isLoopback(n.aztecNode)) throw new GuardError("transport", `a rehearsal's node must be loopback, not ${n.aztecNode}`)
	assertStackEndpoints(n, mode.manifest)
}

/** A live run's endpoints are each exactly a pinned URL, the send endpoint included. */
function assertPinned(n: TestnetDeployment["network"]): void {
	if (!isPinned("l1Rpc", n.l1Rpc)) throw new GuardError("transport", `${n.l1Rpc} is not a pinned L1 URL`)
	if (n.l1SendRpc === undefined || !isPinned("l1SendRpc", n.l1SendRpc))
		throw new GuardError("transport", `${n.l1SendRpc ?? "no l1SendRpc"} is not the pinned L1 send URL`)
	if (!isPinned("aztecNode", n.aztecNode)) throw new GuardError("transport", `${n.aztecNode} is not a pinned node URL`)
}

function assertStackEndpoints(n: TestnetDeployment["network"], manifest: string): void {
	let m: { l1Rpc: string; aztecNode: string }
	try {
		m = parseStackManifest(JSON.parse(readFileSync(manifest, "utf8")))
	} catch (e) {
		throw new GuardError("transport", `the stack manifest ${manifest} cannot be read: ${e instanceof Error ? e.message : String(e)}`)
	}
	if (n.l1Rpc !== m.l1Rpc) throw new GuardError("transport", `the file's L1 ${n.l1Rpc} is not the stack's ${m.l1Rpc}`)
	if (n.aztecNode !== m.aztecNode) throw new GuardError("transport", `the file's node ${n.aztecNode} is not the stack's ${m.aztecNode}`)
}

/**
 * On a fork, the L1 answers `web3_clientVersion` with exactly the pinned anvil's version, so a loopback
 * proxy to a public chain is refused before a key is read. A no-op in any other mode.
 * @throws GuardError `fork`
 */
export async function assertForkNode(l1: { request(args: { method: "web3_clientVersion" }): Promise<unknown> }, mode: Mode): Promise<void> {
	if (mode.kind !== "rehearse-fork") return
	const version = await l1.request({ method: "web3_clientVersion" })
	if (version !== ANVIL_CLIENT_VERSION)
		throw new GuardError("fork", `the L1 answers ${JSON.stringify(version)?.slice(0, 80)}, not the pinned ${ANVIL_CLIENT_VERSION}`)
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

/**
 * `SEED` turns Aztec's foundation randomness (secrets, salts, note randomness in its wallet) into a
 * seeded PRNG, so no testnet command runs with it set. Its value is never read into a message.
 * @throws GuardError `env`
 */
export function assertNoSeed(env: NodeJS.ProcessEnv): void {
	if (env.SEED !== undefined) throw new GuardError("env", "SEED is set, which makes Aztec's randomness predictable; unset it")
}

/** Anvil's well-known accounts, the only L1 keys a local rehearsal accepts. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
const ANVIL_ACCOUNTS = 32

let anvilAddresses: Set<string> | undefined
const isAnvilKey = (address: Address) => {
	anvilAddresses ??= new Set(
		Array.from({ length: ANVIL_ACCOUNTS }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address.toLowerCase()),
	)
	return anvilAddresses.has(address.toLowerCase())
}

const real = (path: string) => {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

/**
 * This account's home from the password database. Bun's `os.userInfo().homedir` follows `$HOME`, so it
 * cannot tell a scratch home from the real one.
 * @throws GuardError `keys` when the database has no entry for this uid
 */
export function accountHome(uid: number = process.getuid?.() ?? -1): string {
	const r = spawnSync("getent", ["passwd", String(uid)], { encoding: "utf8" })
	const home = r.status === 0 ? r.stdout.trim().split(":")[5] : undefined
	if (!home) throw new GuardError("keys", `the password database has no home for uid ${uid}`)
	return home
}

/**
 * A fork rehearsal reads the key file under `$HOME`, which must be a scratch home: the account's own
 * home holds the real file.
 * @throws GuardError `keys`
 */
export function assertScratchKeyFile(file: string, home: string = accountHome()): void {
	if (real(dirname(file)) === real(dirname(keyFilePath(home))))
		throw new GuardError(
			"keys",
			"a fork rehearsal reads a scratch key file; set PP_TESTNET_SCRATCH_HOME to a scratch directory, never this account's home",
		)
}

/** Where a CLI's keys come from: the key file (live, fork) and the environment (local stack). */
export type KeySources = { env: NodeJS.ProcessEnv; file?: string; accountHome?: string }

/**
 * Reads exactly `specs`. Live: the key file. Fork rehearsal: a scratch key file, never the account's.
 * Local stack: `PP_REHEARSE_<name>` from the environment, each L1 key one of anvil's; it never opens
 * the key file.
 * @throws GuardError `keys` naming the file or the first missing or malformed variable, never a value
 */
export function readKeys(
	specs: readonly KeySpec[],
	mode: Mode,
	sources: KeySources,
	addressOf: (key: Hex) => Address,
): Record<string, Hex> {
	const keys = mode.kind === "rehearse" ? envKeys(specs, sources.env, addressOf) : fileKeys(specs, mode, sources)
	remember(Object.values(keys))
	return keys
}

/**
 * A fork rehearsal's key file sits under `PP_TESTNET_SCRATCH_HOME`, else `$HOME`, so the command keeps the
 * real home that its tools, port registry and compiler store live under.
 */
const forkKeyFile = (env: NodeJS.ProcessEnv) => keyFilePath(env.PP_TESTNET_SCRATCH_HOME || undefined)

function fileKeys(specs: readonly KeySpec[], mode: Mode, sources: KeySources): Record<string, Hex> {
	const file = sources.file ?? (mode.kind === "rehearse-fork" ? forkKeyFile(sources.env) : keyFilePath())
	if (mode.kind === "rehearse-fork") assertScratchKeyFile(file, sources.accountHome)
	return loadKeys(specs, file)
}

function envKeys(specs: readonly KeySpec[], env: NodeJS.ProcessEnv, addressOf: (key: Hex) => Address): Record<string, Hex> {
	const out: Record<string, Hex> = {}
	for (const { name, kind } of specs) {
		const variable = `PP_REHEARSE_${name}`
		const v = env[variable]
		if (v === undefined || !isKeyValue(kind, v)) throw new GuardError("keys", `${variable} is not set to a valid ${kind} key`)
		if (kind === "l1" && !isAnvilKey(addressOf(v))) throw new GuardError("keys", `${variable} is not one of anvil's well-known keys`)
		out[name] = v
	}
	return out
}
