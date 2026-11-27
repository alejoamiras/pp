// Port claims in the host registry (~/.agents/ports.md), shared with every other agent run on the machine.
// Same row format, lock and window as the bridge sandbox, so either harness picks around the other's ports.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { withFileLock } from "./lock.ts"

/** Ports below the OS dynamic range are never handed to an outgoing connection between probe and spawn. */
const DEFAULT_EPHEMERAL_FLOOR = 32768
const STATIC_LO = 10_000
const FLOOR_GUARD = 512
const MAX_STATIC_TRIES = 256
/** A lock older than this belonged to a run that died holding it. */
const LOCK_STALE_MS = 15_000
/** Outlasts the stale threshold, so a dead holder's lock is always reclaimed before a caller gives up. */
const LOCK_WAIT_MS = LOCK_STALE_MS + 5_000

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")

export function registryPath(): string {
	return process.env.PP_PORTS_REGISTRY ?? join(homedir(), ".agents", "ports.md")
}

function ephemeralFloor(): number {
	try {
		const lo = Number.parseInt(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0] ?? "", 10)
		return Number.isFinite(lo) && lo > STATIC_LO + 256 ? lo : DEFAULT_EPHEMERAL_FLOOR
	} catch {
		return DEFAULT_EPHEMERAL_FLOOR
	}
}

function canBind(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer()
		srv.unref()
		srv.once("error", () => resolve(false))
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)))
	})
}

const portOf = (line: string): number | undefined => {
	const port = Number.parseInt(line.split("|")[1]?.trim() ?? "", 10)
	return Number.isInteger(port) ? port : undefined
}

/** Only the owner column: a run ID can equal another row's service name. */
const ownedBy = (line: string, runId: string): boolean => portOf(line) !== undefined && line.split("|")[3]?.trim() === runId

/** Every port the registry lists, whoever claimed it. */
export function registeredPorts(): Set<number> {
	const ports = new Set<number>()
	if (!existsSync(registryPath())) return ports
	for (const line of readFileSync(registryPath(), "utf8").split("\n")) {
		const port = portOf(line)
		if (port !== undefined) ports.add(port)
	}
	return ports
}

const REGISTRY_HEADER = [
	"# Ports registry — who is RUNNING what, where (atomic-locked)",
	"| port | service | owner (run) | worktree | pid-hint | claimed |",
	"|---|---|---|---|---|---|",
]

/**
 * Replaces the registry by renaming a complete file over it: the readers take no lock, and a writer
 * that dies mid-write must leave the old rows, not a truncated file. A symlinked registry keeps its
 * link, and the file keeps its mode.
 */
function replaceRegistry(registry: string, text: string): void {
	const target = existsSync(registry) ? realpathSync(registry) : registry
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
	const next = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`
	try {
		writeFileSync(next, text, { flag: "wx", mode })
		renameSync(next, target)
	} catch (err) {
		rmSync(next, { force: true })
		throw err
	}
}

async function withRegistry(mutate: (lines: string[]) => string[], registry = registryPath()): Promise<boolean> {
	mkdirSync(dirname(registry), { recursive: true })
	const done = await withFileLock(`${registry}.lock`, { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS }, () => {
		const current = existsSync(registry) ? readFileSync(registry, "utf8") : `${REGISTRY_HEADER.join("\n")}\n`
		replaceRegistry(registry, mutate(current.split("\n")).join("\n"))
	})
	return done !== undefined
}

/** A cell a row can hold and an exact owner match can find again. */
const CELL = /^[^|\s](?:[^|\r\n]*[^|\s])?$/

/** A claim that found one of its ports already listed: pick again. */
export class PortClaimConflict extends Error {
	readonly ports: number[]
	constructor(ports: number[]) {
		super(`ports already claimed in ${registryPath()}: ${ports.join(", ")}`)
		this.ports = ports
	}
}

/** A `sole` claim whose owner already held a row: the check and the write share one lock, so two claims cannot both pass. */
export class OwnerHoldsRows extends Error {
	constructor(runId: string) {
		super(`${runId} already holds rows in ${registryPath()}`)
	}
}

type ClaimOptions = { readonly sole?: boolean }

/**
 * Claims every port of `rows` (service → port) under `runId` in one write under the registry lock, so
 * other runs pick around them from the moment they are chosen, not from when something listens. Throws
 * `PortClaimConflict` when the registry already lists one, `OwnerHoldsRows` when `sole` is set and
 * `runId` already holds a row, and an `Error` when the lock never came free.
 */
export async function claimRows(runId: string, rows: Record<string, number>, pidHint: number, opts: ClaimOptions = {}): Promise<void> {
	const entries = Object.entries(rows)
	for (const cell of [runId, ...entries.map(([service]) => service)]) {
		if (!CELL.test(cell))
			throw new Error(`${JSON.stringify(cell)} cannot be a registry cell: no "|", line break, or leading or trailing space`)
	}
	const claimed = new Date().toISOString()
	const wanted = new Set(entries.map(([, port]) => port))
	const sole = opts.sole === true
	let conflicts: number[] = []
	let held = false
	const written = await withRegistry((lines) => {
		const body = lines.filter((l) => l.trim().length > 0)
		held = sole && body.some((l) => ownedBy(l, runId))
		conflicts = body.map(portOf).filter((p): p is number => p !== undefined && wanted.has(p))
		if (held || conflicts.length > 0) return lines
		const added = entries.map(([service, port]) => `| ${port} | ${service} | ${runId} | ${REPO_ROOT} | ${pidHint} | ${claimed} |`)
		return [...body, ...added, ""]
	})
	if (!written) throw new Error(`${registryPath()} stayed locked; could not claim ports ${[...wanted].join(", ")} for ${runId}`)
	if (held) throw new OwnerHoldsRows(runId)
	if (conflicts.length > 0) throw new PortClaimConflict(conflicts)
}

/** A loopback port that binds now and is registered under `runId` before anything listens on it. */
export async function claimPort(runId: string, service: string, opts: ClaimOptions = {}): Promise<number> {
	const hi = Math.max(STATIC_LO + 256, ephemeralFloor() - FLOOR_GUARD)
	for (let i = 0; i < MAX_STATIC_TRIES; i++) {
		const candidate = STATIC_LO + Math.floor(Math.random() * (hi - STATIC_LO))
		if (registeredPorts().has(candidate) || !(await canBind(candidate))) continue
		try {
			await claimRows(runId, { [service]: candidate }, process.pid, opts)
			return candidate
		} catch (err) {
			if (!(err instanceof PortClaimConflict)) throw err
		}
	}
	throw new Error(`no free loopback port in [${STATIC_LO}, ${hi}) after ${MAX_STATIC_TRIES} probes`)
}

/** Drops every row whose owner column is `runId`, and no other; false when the lock never came free. */
export function releaseRows(runId: string): Promise<boolean> {
	return withRegistry((lines) => lines.filter((l) => !ownedBy(l, runId)))
}

/** One registry row, named by all three of its port, service and owner cells. */
export interface RowRef {
	port: number
	service: string
	owner: string
}

const isRow = (line: string, r: RowRef): boolean => {
	const cells = line.split("|").map((c) => c.trim())
	return portOf(line) === r.port && cells[2] === r.service && cells[3] === r.owner
}

/**
 * Drops exactly the rows `refs` names from the registry at `registry`, and no other, under the same lock
 * as a claim; false when the lock never came free.
 */
export function releaseNamed(refs: readonly RowRef[], registry = registryPath()): Promise<boolean> {
	if (refs.length === 0) return Promise.resolve(true)
	return withRegistry((lines) => lines.filter((l) => !refs.some((r) => isRow(l, r))), registry)
}

/** Drops every row `runId` owns; throws if a live holder kept the registry locked throughout. */
export async function releasePorts(runId: string): Promise<void> {
	if (await releaseRows(runId)) return
	throw new Error(`${registryPath()} stayed locked; the rows owned by ${runId} are still there`)
}

/** The run whose row lists `port`, if any. */
export function portOwner(port: number): string | undefined {
	if (!existsSync(registryPath())) return undefined
	const row = readFileSync(registryPath(), "utf8")
		.split("\n")
		.find((l) => portOf(l) === port)
	return row?.split("|")[3]?.trim()
}

export function rowsOwnedBy(runId: string): number {
	if (!existsSync(registryPath())) return 0
	return readFileSync(registryPath(), "utf8")
		.split("\n")
		.filter((l) => ownedBy(l, runId)).length
}
