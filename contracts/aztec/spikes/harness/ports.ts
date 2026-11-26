// Port claims in the host registry shared by every agent on this machine (~/.agents/ports.md).
// Adapted from Unleashed's local-network harness (Apache-2.0).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const REGISTRY = join(homedir(), ".agents", "ports.md")
const LOCK = `${REGISTRY}.lock`
// A lock older than this belonged to a run that died holding it; holders keep it for milliseconds.
const LOCK_STALE_MS = 15_000
// Written into the lock so a holder whose stale lock was reclaimed never removes its successor's.
const TOKEN = `${process.pid}-${Math.random().toString(36).slice(2)}`
// Ports below the kernel's ephemeral range are never handed to an outgoing connection between the bind test and the spawn.
const STATIC_LO = 10_000
const HEADER = [
	"# Ports registry — who is RUNNING what, where (atomic-locked)",
	"| port | service | owner (run) | worktree | pid-hint | claimed |",
	"|---|---|---|---|---|---|",
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function ephemeralFloor(): number {
	try {
		const lo = Number.parseInt(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0] ?? "", 10)
		return Number.isFinite(lo) && lo > STATIC_LO + 1024 ? lo : 32_768
	} catch {
		return 32_768
	}
}

function bindable(port: number): Promise<boolean> {
	return new Promise((res) => {
		const srv = createServer()
		srv.unref()
		srv.once("error", () => res(false))
		srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)))
	})
}

const ownerOf = (line: string): string | undefined => line.split("|")[3]?.trim()

const portOf = (line: string): number | undefined => {
	const port = Number.parseInt(line.split("|")[1]?.trim() ?? "", 10)
	return Number.isInteger(port) ? port : undefined
}

function registered(lines: string[]): Set<number> {
	return new Set(lines.map(portOf).filter((p): p is number => p !== undefined))
}

function tryLock(): boolean {
	try {
		writeFileSync(LOCK, TOKEN, { flag: "wx", mode: 0o600 })
		return true
	} catch {
		try {
			if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK)
		} catch {}
		return false
	}
}

function unlock(): void {
	try {
		if (readFileSync(LOCK, "utf8") === TOKEN) unlinkSync(LOCK)
	} catch {}
}

/** Replaces the table atomically: an interrupted write must not truncate other runs' rows. */
function writeRegistry(lines: string[]): void {
	const tmp = `${REGISTRY}.${TOKEN}.tmp`
	writeFileSync(tmp, lines.join("\n"))
	renameSync(tmp, REGISTRY)
}

async function withRegistry<T>(mutate: (lines: string[]) => { lines: string[]; result: T }): Promise<T> {
	mkdirSync(dirname(REGISTRY), { recursive: true })
	for (let i = 0; i < 100; i++) {
		if (tryLock()) {
			try {
				const text = existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : `${HEADER.join("\n")}\n`
				const { lines, result } = mutate(text.split("\n"))
				writeRegistry(lines)
				return result
			} finally {
				unlock()
			}
		}
		await sleep(100)
	}
	throw new Error(`${REGISTRY} stayed locked`)
}

/**
 * Picks `services.length` free loopback ports and records them under `runId` in one locked write, so other runs
 * avoid them from the moment they are chosen, not from the moment something listens.
 */
export async function claimPorts<S extends string>(runId: string, services: readonly S[]): Promise<Record<S, number>> {
	const hi = ephemeralFloor() - 512
	const snapshot = existsSync(REGISTRY) ? registered(readFileSync(REGISTRY, "utf8").split("\n")) : new Set<number>()
	for (let attempt = 0; attempt < 5; attempt++) {
		const picked: number[] = []
		for (let tries = 0; picked.length < services.length && tries < 512; tries++) {
			const p = STATIC_LO + Math.floor(Math.random() * (hi - STATIC_LO))
			if (!snapshot.has(p) && !picked.includes(p) && (await bindable(p))) picked.push(p)
		}
		if (picked.length < services.length) throw new Error(`no free loopback ports in [${STATIC_LO}, ${hi})`)
		const claimed = new Date().toISOString()
		const ok = await withRegistry((lines) => {
			const taken = registered(lines)
			if (picked.some((p) => taken.has(p))) return { lines, result: false }
			const body = lines.filter((l) => l.trim().length > 0)
			const rows = services.map((s, i) => `| ${picked[i]} | aztec-spikes-${s} | ${runId} | ${process.cwd()} | ${process.pid} | ${claimed} |`)
			return { lines: [...body, ...rows, ""], result: true }
		})
		if (ok) return Object.fromEntries(services.map((s, i) => [s, picked[i]])) as Record<S, number>
	}
	throw new Error("ports kept colliding with other runs' claims")
}

/** Drops every row `runId` owns. Never throws: a registry hiccup must not fail an otherwise clean run. */
export async function releasePorts(runId: string): Promise<void> {
	try {
		await withRegistry((lines) => ({ lines: lines.filter((l) => ownerOf(l) !== runId), result: undefined }))
	} catch (e) {
		console.warn(`[ports] could not release rows of ${runId}: ${(e as Error).message}`)
	}
}

/**
 * Blocking variant for an `exit` hook: vitest's own signal handling exits before an async release can finish.
 * Gives up after about two seconds and says so, rather than hang the exit.
 */
export function releasePortsSync(runId: string): void {
	const pause = new Int32Array(new SharedArrayBuffer(4))
	for (let i = 0; i < 20; i++) {
		if (tryLock()) {
			try {
				if (existsSync(REGISTRY)) {
					writeRegistry(
						readFileSync(REGISTRY, "utf8")
							.split("\n")
							.filter((l) => ownerOf(l) !== runId),
					)
				}
			} finally {
				unlock()
			}
			return
		}
		Atomics.wait(pause, 0, 0, 100)
	}
	console.warn(`[ports] registry stayed locked; remove the rows of ${runId} by hand`)
}

export function rowsOwnedBy(runId: string): string[] {
	if (!existsSync(REGISTRY)) return []
	return readFileSync(REGISTRY, "utf8")
		.split("\n")
		.filter((l) => ownerOf(l) === runId)
}
