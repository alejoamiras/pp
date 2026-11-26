/**
 * A per-run local network (anvil + `aztec start --local-network`) the sandbox scripts OWN: ports
 * drawn from a static window below the ephemeral floor, data on real disk, and a `stop()` that
 * signals exactly the process GROUPS this module spawned. Other agents run their own anvil and
 * aztec on the same machine, so a name-matched kill would take down someone else's network.
 *
 * `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` together attach to an already-running network instead
 * (a no-op `stop()`), which is how `--keep` is re-entered.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { randomBytes, randomInt } from "node:crypto"
import {
	accessSync,
	closeSync,
	constants,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ANVIL_ACCOUNTS } from "./constants"

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, "..", "..")
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Port reservation ────────────────────────────────────────────────────────

/** Ports at or above the OS dynamic range can be handed to an OUTGOING connection between the
 *  bind test and the spawn; ports below it never are, which is the property the pack needs. */
const DEFAULT_EPHEMERAL_FLOOR = 32768
const STATIC_LO = 10_000
const FLOOR_GUARD = 512
const MAX_STATIC_TRIES = 256

interface PortReservation {
	port: number
	release: () => Promise<void>
}

async function ephemeralFloor(): Promise<number> {
	try {
		const raw = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
		const lo = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10)
		return Number.isFinite(lo) && lo > STATIC_LO + 256 ? lo : DEFAULT_EPHEMERAL_FLOOR
	} catch {
		return DEFAULT_EPHEMERAL_FLOOR
	}
}

/** Resolves `null` on ANY bind failure so the probe loop stays a plain retry. */
function tryBind(port: number): Promise<PortReservation | null> {
	return new Promise((res) => {
		const srv = createServer()
		srv.unref()
		let settled = false
		const settle = (v: PortReservation | null) => {
			if (settled) return
			settled = true
			res(v)
		}
		srv.once("error", () => {
			srv.close()
			settle(null)
		})
		srv.listen(port, "127.0.0.1", () => {
			const addr = srv.address()
			if (!addr || typeof addr !== "object") {
				srv.close()
				settle(null)
				return
			}
			settle({ port: addr.port, release: () => new Promise<void>((rs) => srv.close(() => rs())) })
		})
	})
}

async function reservePort(): Promise<PortReservation> {
	const hi = Math.max(STATIC_LO + 256, (await ephemeralFloor()) - FLOOR_GUARD)
	const span = hi - STATIC_LO
	// A port another run claimed in the registry is taken even while nothing listens on it yet.
	const claimed = registeredPorts()
	for (let i = 0; i < MAX_STATIC_TRIES && span >= 256; i++) {
		const candidate = STATIC_LO + Math.floor(Math.random() * span)
		if (claimed.has(candidate)) continue
		const reservation = await tryBind(candidate)
		if (reservation) return reservation
	}
	throw new Error(`no free loopback port in [${STATIC_LO}, ${hi}) after ${MAX_STATIC_TRIES} probes — the static window is exhausted`)
}

export type SandboxPorts = {
	anvil: number
	aztec: number
	aztecAdmin: number
	aztecP2P: number
}

/** Four distinct loopback ports, bind-tested against each other and released for the spawn. */
export async function reserveSandboxPorts(): Promise<SandboxPorts> {
	const held = [await reservePort(), await reservePort(), await reservePort(), await reservePort()]
	const ports = { anvil: held[0].port, aztec: held[1].port, aztecAdmin: held[2].port, aztecP2P: held[3].port }
	await Promise.all(held.map((h) => h.release()))
	return ports
}

// ─── Host port registry (~/.agents/ports.md) ─────────────────────────────────

const REGISTRY = join(homedir(), ".agents", "ports.md")
const REGISTRY_LOCK = `${REGISTRY}.lock`
/** A lock older than this belonged to a run that died holding it; the alternative is a deadlock. */
const LOCK_STALE_MS = 15_000

function tryAcquireLock(): boolean {
	try {
		closeSync(openSync(REGISTRY_LOCK, "wx", 0o600))
		return true
	} catch {
		try {
			if (Date.now() - statSync(REGISTRY_LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(REGISTRY_LOCK)
		} catch {}
		return false
	}
}

const REGISTRY_HEADER = [
	"# Ports registry — who is RUNNING what, where (atomic-locked)",
	"| port | service | owner (run) | worktree | pid-hint | claimed |",
	"|---|---|---|---|---|---|",
]

/** Rewrites the registry under the lock; `false` when the lock never came free. A host without a
 *  registry gets one — created under that same lock, so two first runs cannot both create it —
 *  because the claims are what keep a run's own ports apart from its next allocation. */
async function withRegistry(mutate: (lines: string[]) => string[]): Promise<boolean> {
	mkdirSync(dirname(REGISTRY), { recursive: true })
	for (let i = 0; i < 60; i++) {
		if (tryAcquireLock()) {
			try {
				const current = existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : `${REGISTRY_HEADER.join("\n")}\n`
				writeFileSync(REGISTRY, `${mutate(current.split("\n")).join("\n")}`)
			} finally {
				try {
					unlinkSync(REGISTRY_LOCK)
				} catch {}
			}
			return true
		}
		await sleep(100)
	}
	return false
}

const ownerCell = (runId: string) => `| ${runId} |`

const pidsOf = (spawned: readonly OwnedChild[]) => spawned.map((o) => o.child.pid).filter((p): p is number => p !== undefined)

const portOf = (line: string): number | undefined => {
	const port = Number.parseInt(line.split("|")[1]?.trim() ?? "", 10)
	return Number.isInteger(port) ? port : undefined
}

/** Every port the registry lists, whoever claimed it; empty when the host keeps no registry yet. */
export function registeredPorts(): Set<number> {
	const ports = new Set<number>()
	if (!existsSync(REGISTRY)) return ports
	for (const line of readFileSync(REGISTRY, "utf8").split("\n")) {
		const port = portOf(line)
		if (port !== undefined) ports.add(port)
	}
	return ports
}

/** A claim that found one of its ports already owned by another run: pick again. */
export class PortClaimConflict extends Error {
	constructor(readonly ports: number[]) {
		super(`ports already claimed in ${REGISTRY}: ${ports.join(", ")}`)
	}
}

/**
 * Claim ports in the host registry under `runId`, one row per service (`<label>-<service>`), so
 * every other run on this host — this package's sandboxes included — picks around them from the
 * moment they are resolved, not from the moment something listens on them. The check and the
 * write happen under one lock: a port another run claimed meanwhile throws `PortClaimConflict`,
 * and a lock that never comes free throws — an unclaimed port is not one to build on.
 */
export async function registerHostPorts(runId: string, label: string, ports: Record<string, number>, pidHint: number): Promise<void> {
	const claimed = new Date().toISOString()
	const wanted = new Set(Object.values(ports))
	let conflicts: number[] = []
	const written = await withRegistry((lines) => {
		const body = lines.filter((l) => l.trim().length > 0)
		conflicts = body.map(portOf).filter((p): p is number => p !== undefined && wanted.has(p))
		if (conflicts.length > 0) return lines
		const rows = Object.entries(ports).map(
			([service, port]) => `| ${port} | ${label}-${service} | ${runId} | ${REPO_ROOT} | ${pidHint} | ${claimed} |`,
		)
		return [...body, ...rows, ""]
	})
	if (!written) throw new Error(`${REGISTRY} stayed locked — could not claim ports ${[...wanted].join(", ")} for ${runId}`)
	if (conflicts.length > 0) throw new PortClaimConflict(conflicts)
}

/** Drop every row `runId` owns. A registry that stayed locked keeps them; the warning is what makes
 *  the leak recoverable by hand. Never throws — a registry hiccup must not fail an otherwise clean run. */
export async function releaseHostPorts(runId: string, ports: Record<string, number>): Promise<void> {
	if (await withRegistry((lines) => lines.filter((l) => !l.includes(ownerCell(runId))))) return
	console.warn(
		`[sandbox] ${REGISTRY} stayed locked — remove the rows owned by ${runId} (ports ${Object.values(ports).join(", ")}) by hand`,
	)
}

const releasePorts = (runId: string, ports: SandboxPorts) => releaseHostPorts(runId, ports)

/** Four ports reserved AND claimed: a pick another run claimed in between is simply picked again. */
async function claimSandboxPorts(runId: string): Promise<SandboxPorts> {
	for (let attempt = 0; ; attempt++) {
		const ports = await reserveSandboxPorts()
		try {
			await registerHostPorts(runId, "bridge-sandbox", ports, process.pid)
			return ports
		} catch (e) {
			if (!(e instanceof PortClaimConflict) || attempt >= 4) throw e
		}
	}
}

// ─── Toolchain ───────────────────────────────────────────────────────────────

/** The `@aztec-labs/aztec.js` pin this package declares — the toolchain version that matches it. */
export function aztecPin(): string {
	const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> }
	const pin = pkg.dependencies?.["@aztec-labs/aztec.js"]
	if (typeof pin !== "string" || pin.length === 0) {
		throw new Error("packages/bridge-core/package.json declares no @aztec-labs/aztec.js — cannot locate the matching toolchain")
	}
	return pin
}

function isExecutable(p: string): boolean {
	try {
		accessSync(p, constants.X_OK)
		return true
	} catch {
		return false
	}
}

interface Toolchain {
	anvilBin: string
	aztecBin: string
	/** The CLI entry `aztecBin` (a shell wrapper) would exec. */
	aztecEntry: string
	internalBin: string
}

/**
 * The pinned root is usable only as a COMPLETE toolchain: `@aztec-labs/ethereum` resolves forge/anvil
 * from `~/.aztec/current` ahead of PATH, so a partial install would silently deploy L1 with
 * whatever version another agent's `aztec-up` last pointed that symlink at.
 */
function resolveToolchain(root: string): Toolchain {
	const tool = {
		anvilBin: join(root, "bin", "aztec-anvil"),
		aztecBin: join(root, "node_modules", ".bin", "aztec"),
		internalBin: join(root, "internal-bin"),
	}
	const missing = [tool.anvilBin, tool.aztecBin, join(tool.internalBin, "forge"), join(tool.internalBin, "anvil")].filter(
		(p) => !isExecutable(p),
	)
	if (missing.length > 0) {
		throw new Error(`aztec toolchain at ${root} is incomplete (missing ${missing.join(", ")}) — run: aztec-up install ${aztecPin()}`)
	}
	const aztecEntry = join(dirname(realpathSync(tool.aztecBin)), "..", "dest", "bin", "index.js")
	if (!existsSync(aztecEntry)) throw new Error(`aztec toolchain at ${root} has no CLI entry at ${aztecEntry}`)
	return { ...tool, aztecEntry }
}

// ─── Listening sockets ───────────────────────────────────────────────────────

export interface Listener {
	pid: number
	address: string
	port: number
}

/** Parses `ss -ltnpH`: one entry per listening socket and owning pid. */
export function parseListeners(ss: string): Listener[] {
	return ss.split("\n").flatMap((line) => {
		const address = line.trim().split(/\s+/)[3] ?? ""
		const port = Number(address.slice(address.lastIndexOf(":") + 1))
		if (!Number.isInteger(port) || port <= 0) return []
		return [...line.matchAll(/pid=(\d+)/g)].map((m) => ({ pid: Number(m[1]), address, port }))
	})
}

/** Listeners on a port the run never claimed: anything there sits outside the registry. */
export function strayListeners(listeners: readonly Listener[], claimed: readonly number[]): Listener[] {
	return listeners.filter((l) => !claimed.includes(l.port))
}

/** Every TCP listener of every process in the given groups; undefined where `ps` or `ss` is missing.
 *  `aztec start` has no bind-host option, so these are logged at boot rather than assumed. */
function groupListeners(pgids: readonly number[]): Listener[] | undefined {
	try {
		const members = new Set(
			execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" })
				.split("\n")
				.map((l) => l.trim().split(/\s+/).map(Number))
				.filter(([, pgid]) => pgids.includes(pgid as number))
				.map(([pid]) => pid as number),
		)
		return parseListeners(execFileSync("ss", ["-ltnpH"], { encoding: "utf8" })).filter((l) => members.has(l.pid))
	} catch {
		return undefined
	}
}

// ─── Health ──────────────────────────────────────────────────────────────────

async function rpcResponds(url: string, method: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
		})
		if (!res.ok) return false
		return ((await res.json()) as { result?: unknown }).result != null
	} catch {
		return false
	}
}

async function waitHealthy(label: string, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (await probe()) return
		await sleep(500)
	}
	throw new Error(`${label} did not answer within ${timeoutMs}ms`)
}

// ─── Process ownership ───────────────────────────────────────────────────────

/** A spawned child plus the one authority on whether it is still running: its own `exit` event.
 *  `killed` only records that a signal was sent, and an exited PID may already name someone else. */
export interface OwnedChild {
	child: ChildProcess
	hasExited: () => boolean
	exited: Promise<void>
}

export function own(child: ChildProcess): OwnedChild {
	let done = false
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => {
			done = true
			resolve()
		})
	})
	return { child, hasExited: () => done, exited }
}

/** The timer is cleared on exit so a child that goes down at once does not hold the loop open. */
function exitedWithin(owned: OwnedChild, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		void owned.exited.then(() => {
			clearTimeout(timer)
			resolve()
		})
	})
}

/** Whether `-pid` still names the group this module created. Once the leader has exited, a live
 *  member keeps its number reserved, so a live group whose number names no process is ours; a process
 *  holding the number got it after our group died and is a stranger. Assumes the number is not handed
 *  out again, and its new group orphaned, within one run. */
function ownsGroup(owned: OwnedChild): boolean {
	const pid = owned.child.pid
	if (pid === undefined) return false
	return !owned.hasExited() || (groupAlive(pid) && !processExists(pid))
}

/** Signals the process GROUP this module created (`detached: true` makes the child a group leader),
 *  so the node's own children die with it, and nothing else on the machine is touched. */
export async function killGroup(owned: OwnedChild): Promise<void> {
	const pid = owned.child.pid
	if (pid === undefined || !ownsGroup(owned)) return
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig)
		} catch {
			try {
				owned.child.kill(sig)
			} catch {}
		}
	}
	if (!owned.hasExited()) {
		signal("SIGTERM")
		await exitedWithin(owned, 5_000)
	}
	// The leader going down does not take its group with it: a member that ignores SIGTERM (the
	// node's AVM simulator does) keeps running.
	if (!ownsGroup(owned)) return
	signal("SIGKILL")
	// A killed member counts in the group until it is reaped; callers check for leftovers next.
	for (const end = Date.now() + 5_000; groupAlive(pid) && Date.now() < end; ) await sleep(50)
}

/** Signal 0 probes without delivering: true while any process is still in the group. */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0)
		return true
	} catch {
		return false
	}
}

/** EPERM still means the PID exists, held by another user. */
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** What a stopped run still holds, found by its own identifiers: directories that exist, process
 *  groups with a live member, registry rows naming its run id. */
export function runLeftovers(run: { runId: string; dirs: readonly string[]; pgids: readonly number[] }): string[] {
	const left = run.dirs.filter((dir) => existsSync(dir)).map((dir) => `directory ${dir}`)
	for (const pgid of run.pgids) if (groupAlive(pgid)) left.push(`process group ${pgid}`)
	const rows = existsSync(REGISTRY)
		? readFileSync(REGISTRY, "utf8")
				.split("\n")
				.filter((l) => l.includes(ownerCell(run.runId)))
		: []
	if (rows.length) left.push(`${rows.length} registry row(s) owned by ${run.runId}`)
	return left
}

/** The sandbox's home on real disk; each run owns one subdirectory. The CI workflows upload
 *  `logs/` from this same path. */
export const SANDBOX_CACHE_DIR = join(homedir(), ".cache", "pp", "bridge-sandbox")

/** Per-run `TMPDIR`s, kept short: the node binds Unix sockets under it (`cdb-ts-<pid>-<thread>-<n>.sock`)
 *  and a path past the kernel's limit fails the bind, which leaves its AVM simulator retrying forever. */
export const SANDBOX_TMP_ROOT = join(homedir(), ".cache", "pp", "t")

/** `sun_path` holds 108 bytes including the terminating NUL. */
const MAX_SOCKET_PATH = 107

/** Refuses a temp dir the node's longest IPC socket name would not fit in (pid ≤ 2^22, counters ≤ 999). */
export function assertSocketRoom(tmpDir: string): void {
	const longest = join(tmpDir, "cdb-ts-4194304-999-999.sock")
	const bytes = Buffer.byteLength(longest)
	if (bytes > MAX_SOCKET_PATH) {
		throw new Error(
			`TMPDIR ${tmpDir} leaves no room for the node's IPC sockets (${bytes} > ${MAX_SOCKET_PATH} bytes); use a shorter home`,
		)
	}
}

/** Where a run's node and anvil output goes — outside the data directory, which teardown removes,
 *  so a failed CI run can still upload it. */
export const SANDBOX_LOG_DIR = join(SANDBOX_CACHE_DIR, "logs")

/** The full stream to a per-run file; errors echoed to the console as they happen. Both streams must be
 *  read: a full 64 KiB pipe blocks the child's next write, and the node stops sequencing silently. */
function drainOutput(child: ChildProcess, label: string, logFile: string): void {
	mkdirSync(dirname(logFile), { recursive: true })
	const sink = createWriteStream(logFile, { flags: "a" })
	// Open and write errors arrive asynchronously; unhandled, they would crash the host past `stop`.
	sink.on("error", (e) => console.error(`[${label}] cannot write ${logFile}: ${e.message}`))
	const report = (data: Buffer) => {
		sink.write(data)
		const line = data.toString().trim()
		if (/\bERROR\b|\bFATAL\b|already in use/i.test(line)) console.error(`[${label}]`, line.slice(0, 200))
	}
	child.stdout?.on("data", report)
	child.stderr?.on("data", report)
	// `close` follows the stdio streams' end; `exit` can precede their last chunks.
	child.once("close", () => sink.end())
}

function spawnAnvil(tool: Toolchain, port: number): ChildProcess {
	const child = spawn(
		tool.anvilBin,
		// Every key the handle advertises (`deploy.ts` funds none itself) must be one anvil pre-funds.
		// The base fee starts at 7 wei, below which EIP-1559's per-block decrease rounds to zero. From anvil's
		// default 1 gwei it falls 12.5 % a block, and on 6.0.0 the rollup's mana min fee follows it down in
		// steps (about 40,000-fold in a run's first five minutes), breaking flows that size credit to a ceiling.
		[
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--chain-id",
			"31337",
			"--slots-in-an-epoch",
			"1",
			"--block-base-fee-per-gas",
			"7",
			"--accounts",
			String(ANVIL_ACCOUNTS),
			"--silent",
		],
		{ stdio: "pipe", detached: true },
	)
	return child
}

function nodeEnv(tool: Toolchain, anvilUrl: string, dirs: { data: string; tmp: string }): NodeJS.ProcessEnv {
	const forge = join(tool.internalBin, "forge")
	const anvil = join(tool.internalBin, "anvil")
	// A shell that disables or resets the admin key would override the hash below: the node reads
	// those switches first. The child never inherits them.
	const { AZTEC_DISABLE_ADMIN_API_KEY: _disable, AZTEC_RESET_ADMIN_API_KEY: _reset, ...inherited } = process.env
	return {
		...inherited,
		PATH: `${tool.internalBin}${delimiter}${process.env.PATH ?? ""}`,
		// Drops the sequencer's per-block transaction floor so a single tx makes a block. It does NOT
		// make the chain tick on its own — this network still builds a block only when a transaction
		// arrives, which is why the L1→L2 waits carry a `forceBlock`.
		SEQ_MIN_TX_PER_BLOCK: "0",
		// What `aztec.sh` exports for `start --local-network`; `spawnNode` bypasses that script.
		ARCHIVER_POLLING_INTERVAL_MS: "500",
		P2P_BLOCK_CHECK_INTERVAL_MS: "500",
		SEQ_TX_POLLING_INTERVAL_MS: "500",
		WS_BLOCK_CHECK_INTERVAL_MS: "500",
		ARCHIVER_VIEM_POLLING_INTERVAL_MS: "500",
		TEST_ACCOUNTS: inherited.TEST_ACCOUNTS || "true",
		LOG_LEVEL: inherited.LOG_LEVEL || "info;silent:sequencer;verbose:debug_log",
		DEPLOY_AZTEC_CONTRACTS_SALT: inherited.DEPLOY_AZTEC_CONTRACTS_SALT || String(randomInt(32768)),
		L1_CHAIN_ID: "31337",
		AZTEC_SHELL_WRAPPER: "1",
		ETHEREUM_HOSTS: anvilUrl,
		// `start --local-network` builds the node's config from the environment and drops
		// `--data-directory`; without DATA_DIRECTORY every store is a temp store under `os.tmpdir()`.
		// Both are the run's own, so teardown removes everything the node wrote.
		DATA_DIRECTORY: dirs.data,
		TMPDIR: dirs.tmp,
		// The admin listener stays authenticated, behind a key hash nothing matches: a key the node
		// mints itself is PRINTED — into the log this run keeps and CI uploads — and disabling the key
		// would leave the admin API open on every interface. Nothing here needs that API.
		AZTEC_ADMIN_API_KEY_HASH: randomBytes(32).toString("hex"),
		// `@aztec-labs/ethereum`'s resolver reads `~/.aztec/current/internal-bin/forge` ahead of PATH; these
		// overrides are its highest-priority source and the only way to pin the L1 deploy to this version.
		...(isExecutable(forge) ? { FORGE_BIN: forge } : {}),
		...(isExecutable(anvil) ? { ANVIL_BIN: anvil } : {}),
	}
}

/** Runs the CLI entry, not `aztecBin`: for `start --local-network` that wrapper also starts its own
 *  anvil on a fixed port (8545 unless ANVIL_PORT is set), outside the registry. */
function spawnNode(tool: Toolchain, p: { ports: SandboxPorts; anvilUrl: string; dirs: { data: string; tmp: string } }): ChildProcess {
	const child = spawn(
		"node",
		[
			"--no-warnings",
			tool.aztecEntry,
			"start",
			"--local-network",
			"--port",
			String(p.ports.aztec),
			"--admin-port",
			String(p.ports.aztecAdmin),
			"--p2p.p2pPort",
			String(p.ports.aztecP2P),
			"--l1-rpc-urls",
			p.anvilUrl,
		],
		{ stdio: "pipe", detached: true, env: nodeEnv(tool, p.anvilUrl, p.dirs) },
	)
	return child
}

// ─── Public surface ──────────────────────────────────────────────────────────

export interface LocalNetwork {
	anvilUrl: string
	nodeUrl: string
	stop(): Promise<void>
	/** What this run still holds; meaningful after `stop`. Always empty for an attached network,
	 *  which this process never owned. */
	leftovers(): string[]
}

/** Throws when a stopped network left anything behind. */
export function assertNothingLeft(net: LocalNetwork): void {
	const left = net.leftovers()
	if (left.length) throw new Error(`[sandbox] the stopped network left behind: ${left.join("; ")}`)
}

/** Both env vars together mean "use the network already running"; one alone would boot a fresh
 *  network whose other half the operator pointed elsewhere, so it is refused rather than guessed. */
function attachedNetwork(): LocalNetwork | undefined {
	const anvilUrl = process.env.SANDBOX_L1_RPC
	const nodeUrl = process.env.SANDBOX_NODE_URL
	if (!anvilUrl && !nodeUrl) return undefined
	if (!anvilUrl || !nodeUrl) {
		throw new Error(
			`SANDBOX_L1_RPC and SANDBOX_NODE_URL must be set together — only ${anvilUrl ? "SANDBOX_L1_RPC" : "SANDBOX_NODE_URL"} is set`,
		)
	}
	return { anvilUrl, nodeUrl, stop: () => Promise.resolve(), leftovers: () => [] }
}

export interface StartLocalNetworkOptions {
	/** Names the data directory and the registry rows this run owns. */
	runId: string
	/** Defaults to the installed toolchain matching this package's `@aztec-labs/aztec.js` pin. */
	toolchainRoot?: string
	/** Default true: SIGINT, SIGTERM and SIGHUP stop the network and exit 130. A host that owns other
	 *  services passes false and calls `stop` in its own teardown order. */
	signals?: boolean
}

/**
 * Each child leads its own process group, so an interrupt to THIS group leaves them running with
 * their ports still claimed: reap them on the way out, on SIGHUP too. The handlers stay registered
 * (`stop` must be idempotent) because `signal-exit` re-raises a signal it finds itself alone on and
 * `bun run` forwards a second SIGTERM; a `once` handler let that one orphan anvil.
 */
export function reapOnSignals(stop: () => Promise<void>): () => void {
	const onSignal = () => {
		void stop().then(() => process.exit(130))
	}
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
	for (const signal of signals) process.on(signal, onSignal)
	return () => {
		for (const signal of signals) process.off(signal, onSignal)
	}
}

/** A run id names a directory that teardown deletes recursively, so it must stay one path segment. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Boots anvil + an aztec local network, or attaches to the one the env names. The data directory is
 * on real disk under `~/.cache`: a tmpfs store killed before teardown pins multi-GB of RAM in a
 * deleted-but-open file until its holder dies.
 */
export async function startLocalNetwork(opts: StartLocalNetworkOptions): Promise<LocalNetwork> {
	const attached = attachedNetwork()
	if (attached) {
		console.log(`[sandbox] attaching to ${attached.anvilUrl} + ${attached.nodeUrl}`)
		return attached
	}
	if (!RUN_ID.test(opts.runId)) throw new Error(`run id ${JSON.stringify(opts.runId)} is not a single path segment`)
	if (runLeftovers({ runId: opts.runId, dirs: [], pgids: [] }).length > 0) {
		throw new Error(`run id ${opts.runId} already owns registry rows; another run is using it`)
	}
	const tool = resolveToolchain(opts.toolchainRoot ?? join(homedir(), ".aztec", "versions", aztecPin()))
	const dataDir = join(SANDBOX_CACHE_DIR, opts.runId)
	const tmpDir = join(SANDBOX_TMP_ROOT, randomBytes(4).toString("hex"))
	assertSocketRoom(tmpDir)
	// From the claim on, every failure must pass through `stop`, or the registry rows outlive the run.
	const ports = await claimSandboxPorts(opts.runId)
	const anvilUrl = `http://127.0.0.1:${ports.anvil}`
	const nodeUrl = `http://127.0.0.1:${ports.aztec}`
	// Only what this run created: a path that already existed belongs to someone else.
	const created: string[] = []
	const removeDirs = () => {
		for (const dir of created) rmSync(dir, { recursive: true, force: true })
	}
	const spawned: OwnedChild[] = []
	let stopping: Promise<void> | undefined
	// Idempotent: a second signal while the first stop runs must not re-walk (and re-reverse) the list.
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			for (const owned of [...spawned].reverse()) await killGroup(owned)
			await releasePorts(opts.runId, ports)
			// The store belongs to this network and nothing outlives it; removing it only after the
			// holders are gone is what keeps the pages from staying pinned.
			removeDirs()
			// A stopped network's handlers would otherwise exit the host during a later network's teardown.
			unregister()
			process.off("exit", onExit)
		})()
		return stopping
	}
	const unregister = opts.signals === false ? () => {} : reapOnSignals(stop)
	// A host that exits without waiting (vitest's own signal handling, an uncaught error) still must
	// not orphan a node holding a multi-GB store: the last-resort reap is synchronous.
	const onExit = () => {
		for (const owned of spawned) {
			if (owned.child.pid === undefined || !ownsGroup(owned)) continue
			try {
				process.kill(-owned.child.pid, "SIGKILL")
			} catch {}
		}
		removeDirs()
	}
	process.once("exit", onExit)
	// Owned before its output is wired, so a failure there still reaches the child through `stop`.
	const track = (child: ChildProcess, label: string, logFile: string) => {
		spawned.push(own(child))
		drainOutput(child, label, logFile)
	}
	// `stop` reaps the children it sees when it starts; a signal mid-boot must not let one spawn after.
	const stillBooting = () => {
		if (stopping) throw new Error("[sandbox] stopped while booting")
	}
	try {
		for (const dir of [dataDir, tmpDir]) if (mkdirSync(dir, { recursive: true }) !== undefined) created.push(dir)
		console.log(`[sandbox] anvil ${anvilUrl}, aztec ${nodeUrl}, data ${dataDir}, tmp ${tmpDir}`)
		const anvilLog = join(SANDBOX_LOG_DIR, `${opts.runId}-anvil.log`)
		stillBooting()
		track(spawnAnvil(tool, ports.anvil), "anvil", anvilLog)
		await waitHealthy(`anvil at ${anvilUrl}`, () => rpcResponds(anvilUrl, "eth_chainId"), 60_000)
		const nodeLog = join(SANDBOX_LOG_DIR, `${opts.runId}-aztec.log`)
		stillBooting()
		track(spawnNode(tool, { ports, anvilUrl, dirs: { data: dataDir, tmp: tmpDir } }), "aztec", nodeLog)
		await waitHealthy(`aztec node at ${nodeUrl}`, () => rpcResponds(nodeUrl, "node_getNodeInfo"), 180_000)
		const listeners = groupListeners(pidsOf(spawned))
		// Linux hosts and CI have both tools; elsewhere (macOS has no `ss`) the check is skipped.
		if (!listeners && process.platform === "linux") throw new Error("cannot list this run's listeners: `ps` or `ss` failed")
		console.log(
			`[sandbox] local network ready — listening on ${listeners ? listeners.map((l) => l.address).join(" ") : "(ps or ss unavailable)"}`,
		)
		const stray = strayListeners(listeners ?? [], Object.values(ports))
		if (stray.length > 0) {
			throw new Error(`the run listens outside its claimed ports: ${stray.map((l) => `${l.address} (pid ${l.pid})`).join(", ")}`)
		}
	} catch (e) {
		await stop()
		throw e
	}
	const pids = pidsOf(spawned)
	const leftovers = () => runLeftovers({ runId: opts.runId, dirs: [dataDir, tmpDir], pgids: pids })
	return { anvilUrl, nodeUrl, stop, leftovers }
}
