/**
 * The checks `verify-inputs` runs before any key is used: the lockfile, the forge binary and its
 * settings, the creation code and class ids every run deploys, and the endpoints' read support.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, isAddressEqual, parseAbi, type PublicClient } from "viem"
import { buildMismatch } from "./creation"
import { classIds, committedClassIds, committedPoolCodes, FORGE, pinMismatches, poolCreationCodes, sha256File } from "./pins"
import type { TestnetDeployment } from "./schema"

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
export const EVM = join(ROOT, "contracts/bridge/evm")

/** Each check's outcome; `detail` holds paths, versions, hashes and counts, never a key. */
export type CheckResult = { name: string; ok: boolean; detail: string }

const pass = (name: string, detail: string): CheckResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): CheckResult => ({ name, ok: false, detail })

/** `PP_FORGE`, else the first `forge` on `PATH`. */
export function resolveForge(env: NodeJS.ProcessEnv): string | undefined {
	if (env.PP_FORGE) return env.PP_FORGE
	return (env.PATH ?? "")
		.split(delimiter)
		.map((dir) => join(dir, "forge"))
		.find((p) => existsSync(p))
}

const run = (cmd: string, args: string[], cwd: string) =>
	spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, FOUNDRY_PROFILE: "default" }, maxBuffer: 64 * 1024 * 1024 })

/**
 * A keyed run starts from a clean tree at a named commit: `porcelain`, the output of `git status
 * --porcelain`, lists nothing. Untracked files count, since a run can load them; ignored ones do not.
 */
export function treeCheck(porcelain: string, head: string): CheckResult {
	const dirty = porcelain.split("\n").filter((l) => l.trim() !== "")
	if (dirty.length === 0) return pass("tree", `clean at ${head}`)
	return fail("tree", `${dirty.length} uncommitted paths at ${head}, the first ${dirty[0]?.slice(3)}`)
}

/** {@link treeCheck} on this repository, at its root. */
export function checkTree(): CheckResult {
	const status = run("git", ["status", "--porcelain"], ROOT)
	const head = run("git", ["rev-parse", "HEAD"], ROOT)
	if (status.status !== 0 || head.status !== 0) return fail("tree", `git status exited ${status.status}, git rev-parse ${head.status}`)
	return treeCheck(status.stdout, head.stdout.trim())
}

/** A frozen install leaves `bun.lock` byte for byte as committed. */
export function checkLockfile(): CheckResult {
	const lock = join(ROOT, "bun.lock")
	const before = sha256File(lock)
	const r = run(process.execPath, ["install", "--frozen-lockfile"], ROOT)
	if (r.status !== 0) return fail("lockfile", `bun install --frozen-lockfile exited ${r.status}`)
	const after = sha256File(lock)
	return after === before ? pass("lockfile", `bun.lock ${after}`) : fail("lockfile", `bun.lock changed: ${before} → ${after}`)
}

/** The binary's digest is the committed release's for this platform, and it reports that version. */
export function checkForge(forge: string | undefined): CheckResult {
	if (!forge) return fail("forge", "no forge on PATH and PP_FORGE unset")
	const platform = `${process.platform}-${process.arch}`
	const want = FORGE.sha256[platform]
	if (!want) return fail("forge", `no committed digest for ${platform}`)
	const got = sha256File(forge)
	if (got !== want) return fail("forge", `${forge} has sha256 ${got}, the committed ${FORGE.version} is ${want}`)
	const version = run(forge, ["--version"], ROOT).stdout.split("\n")[0] ?? ""
	return version.startsWith(FORGE.version) ? pass("forge", `${forge}: ${version}`) : fail("forge", `${forge} reports ${version}`)
}

/** FFI off in the bridge's Foundry config: a build or script must not run host commands. */
export function checkFfi(forge: string): CheckResult {
	const r = run(forge, ["config", "--json", "--root", EVM], ROOT)
	if (r.status !== 0) return fail("ffi", `forge config exited ${r.status}`)
	const ffi = (JSON.parse(r.stdout) as { ffi?: unknown }).ffi
	return ffi === false ? pass("ffi", "off") : fail("ffi", `ffi is ${String(ffi)}`)
}

/** A forced rebuild in place, then every bridge contract a run deploys hashes to its pin. */
export function checkBuild(forge: string): CheckResult {
	const r = run(forge, ["build", "--force", "--root", EVM], ROOT)
	if (r.status !== 0) return fail("build", `forge build --force exited ${r.status}`)
	const bad = buildMismatch()
	return bad ? fail("build", bad) : pass("build", "PortalFactory matches its pin")
}

/** The own pool's contracts in pp-env's fetched build, and pp-env's test token, hash to their pins. */
export function checkPoolPins(): CheckResult {
	const bad = pinMismatches(poolCreationCodes(), committedPoolCodes())
	return bad.length ? fail("pool-pins", bad.join("; ")) : pass("pool-pins", `${Object.keys(committedPoolCodes()).length} contracts`)
}

/** The labelled token, hub and ASP registry artifacts derive the committed class ids. */
export async function checkClassIds(): Promise<CheckResult> {
	const bad = pinMismatches(await classIds(), committedClassIds())
	return bad.length ? fail("class-ids", bad.join("; ")) : pass("class-ids", `${Object.keys(committedClassIds()).length} classes`)
}

const REGISTRY_ABI = parseAbi(["function getCanonicalRollup() view returns (address)"])
/** The widest log range a run asks for, ending a few blocks behind head. */
export const LOG_SPAN = 10_000n
const HEAD_LAG = 5n

/**
 * The L1 endpoint answers what the runs need: a {@link LOG_SPAN}-block log range, an `eth_call` by block
 * hash with `requireCanonical`, and the `finalized` tag.
 */
export async function probeL1(l1: PublicClient, d: TestnetDeployment): Promise<CheckResult> {
	try {
		const head = await l1.getBlockNumber()
		const toBlock = head - HEAD_LAG
		const logs = await l1.getLogs({ address: d.network.inbox, fromBlock: toBlock - LOG_SPAN + 1n, toBlock })
		const block = await l1.getBlock({ blockNumber: toBlock })
		const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "getCanonicalRollup" })
		const raw = (await l1.request({
			method: "eth_call",
			params: [
				{ to: d.network.l1Registry, data },
				{ blockHash: block.hash as Hex, requireCanonical: true },
			],
		})) as Hex
		const rollup = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "getCanonicalRollup", data: raw }) as Address
		if (!isAddressEqual(rollup, d.network.rollup)) return fail("l1-probe", `the registry's canonical rollup is ${rollup}`)
		const finalized = await l1.getBlock({ blockTag: "finalized" })
		if (finalized.number > head) return fail("l1-probe", `finalized ${finalized.number} is past head ${head}`)
		return pass("l1-probe", `head ${head}, ${logs.length} inbox logs over ${LOG_SPAN} blocks, finalized ${finalized.number}`)
	} catch (e) {
		return fail("l1-probe", e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e))
	}
}

type ProbeNode = {
	getBlockData(
		p: unknown,
	): Promise<{ blockHash: { toString(): string }; header: { globalVariables: { blockNumber: unknown } } } | undefined>
	getPublicStorageAt(block: unknown, contract: AztecAddress, slot: Fr): Promise<Fr>
}

/** The Aztec node serves block data and public storage at a block named by its hash. */
export async function probeNode(node: ProbeNode, d: TestnetDeployment): Promise<CheckResult> {
	try {
		const latest = await node.getBlockData("latest")
		if (!latest) return fail("node-probe", "the node returned no latest block")
		const byHash = await node.getBlockData(latest.blockHash)
		if (byHash?.blockHash.toString() !== latest.blockHash.toString())
			return fail("node-probe", `block ${latest.blockHash} read by hash came back as ${byHash?.blockHash ?? "nothing"}`)
		await node.getPublicStorageAt(latest.blockHash, AztecAddress.fromStringUnsafe(d.network.fpc), new Fr(1))
		return pass("node-probe", `block ${latest.header.globalVariables.blockNumber} by hash, public storage at it`)
	} catch (e) {
		return fail("node-probe", e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e))
	}
}
