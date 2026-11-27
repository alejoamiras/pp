// Port claims in the host registry (~/.agents/ports.md), shared with every other agent run on the machine.
// Same row format, lock and window as the bridge sandbox, so either harness picks around the other's ports.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { PACKAGE_DIR } from "../checkout.ts"
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

const REPO_ROOT = join(PACKAGE_DIR, "../..")

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

async function withRegistry(mutate: (lines: string[]) => string[]): Promise<boolean> {
	const registry = registryPath()
	mkdirSync(dirname(registry), { recursive: true })
	const done = await withFileLock(`${registry}.lock`, { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS }, () => {
		const current = existsSync(registry) ? readFileSync(registry, "utf8") : `${REGISTRY_HEADER.join("\n")}\n`
		writeFileSync(registry, mutate(current.split("\n")).join("\n"))
	})
	return done !== undefined
}

class PortClaimConflict extends Error {}

async function register(runId: string, service: string, port: number): Promise<void> {
	let conflict = false
	const written = await withRegistry((lines) => {
		const body = lines.filter((l) => l.trim().length > 0)
		conflict = body.some((l) => portOf(l) === port)
		if (conflict) return lines
		return [...body, `| ${port} | ${service} | ${runId} | ${REPO_ROOT} | ${process.pid} | ${new Date().toISOString()} |`, ""]
	})
	if (!written) throw new Error(`${registryPath()} stayed locked; could not claim port ${port} for ${runId}`)
	if (conflict) throw new PortClaimConflict(String(port))
}

/** A loopback port that binds now and is registered under `runId` before anything listens on it. */
export async function claimPort(runId: string, service: string): Promise<number> {
	const hi = Math.max(STATIC_LO + 256, ephemeralFloor() - FLOOR_GUARD)
	for (let i = 0; i < MAX_STATIC_TRIES; i++) {
		const candidate = STATIC_LO + Math.floor(Math.random() * (hi - STATIC_LO))
		if (registeredPorts().has(candidate) || !(await canBind(candidate))) continue
		try {
			await register(runId, service, candidate)
			return candidate
		} catch (err) {
			if (!(err instanceof PortClaimConflict)) throw err
		}
	}
	throw new Error(`no free loopback port in [${STATIC_LO}, ${hi}) after ${MAX_STATIC_TRIES} probes`)
}

/** Drops every row `runId` owns; throws if a live holder kept the registry locked throughout. */
export async function releasePorts(runId: string): Promise<void> {
	if (await withRegistry((lines) => lines.filter((l) => !ownedBy(l, runId)))) return
	throw new Error(`${registryPath()} stayed locked; the rows owned by ${runId} are still there`)
}

export function rowsOwnedBy(runId: string): number {
	if (!existsSync(registryPath())) return 0
	return readFileSync(registryPath(), "utf8")
		.split("\n")
		.filter((l) => ownedBy(l, runId)).length
}
