import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { groupAlive, groupMembers } from "@pp/run-isolation/process-group"

const CACHE = join(homedir(), ".cache", "pp")
const REGISTRY = join(homedir(), ".agents", "ports.md")

type Proc = { pid: number; ppid: number; pgid: number; args: string }

function processes(): Proc[] {
	return execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,args="], { encoding: "utf8" })
		.split("\n")
		.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter((m) => m !== null)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] ?? "" }))
}

/** `root` and every live descendant. */
export function processTree(root: number): Proc[] {
	const all = processes()
	const children = new Map<number, Proc[]>()
	for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
	const tree = all.filter((p) => p.pid === root)
	for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]?.pid ?? -1) ?? []))
	return tree
}

/**
 * Samples a process tree every `everyMs` and remembers every process group it saw, since a child
 * that outlives its parent is reparented and drops out of the tree.
 */
export function sampleTree(root: number, ignorePgids: ReadonlySet<number> = new Set(), everyMs = 500) {
	const pgids = new Set<number>()
	const leaders = new Map<number, string>()
	const take = () => {
		for (const p of processTree(root)) {
			if (ignorePgids.has(p.pgid)) continue
			pgids.add(p.pgid)
			const started = p.pid === p.pgid ? startTime(p.pid) : undefined
			if (started) leaders.set(p.pgid, started)
		}
	}
	take()
	const timer = setInterval(take, everyMs)
	const owned = (g: number) => {
		const started = leaders.get(g)
		return started !== undefined && groupAlive(g) && startTime(g) === started
	}
	return {
		pgids,
		/** Live groups whose leader is still the process sampled. */
		ownedAlive: () => [...leaders.keys()].filter(owned),
		/** Live groups seen without a verifiable leader: a reap must not signal them. */
		unverifiedAlive: () => [...pgids].filter((g) => groupAlive(g) && !owned(g)),
		stop: () => clearInterval(timer),
	}
}

/** Field 22 of `/proc/<pid>/stat`, in ticks since boot; a reused pid gets a different one. */
function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
	} catch {
		return undefined
	}
}

export type RegistryRow = { port: number; service: string; owner: string }

export function registryRows(): RegistryRow[] {
	if (!existsSync(REGISTRY)) return []
	return readFileSync(REGISTRY, "utf8")
		.split("\n")
		.map((l) => l.split("|").map((c) => c.trim()))
		.filter((c) => /^\d+$/.test(c[1] ?? ""))
		.map((c) => ({ port: Number(c[1]), service: c[2] ?? "", owner: c[3] ?? "" }))
}

export const portRefuses = (port: number) =>
	new Promise<boolean>((resolve) => {
		const s = connect({ host: "127.0.0.1", port })
		s.once("connect", () => {
			s.destroy()
			resolve(false)
		})
		s.once("error", () => resolve(true))
	})

const ownedBy = (row: RegistryRow, runId: string) => [runId, `${runId}-pool`, `${runId}-bot`].includes(row.owner)

/** A live group's members with their `/proc` state, so a failure shows what kept it running. */
const describeMembers = (pgid: number) =>
	groupMembers(pgid)
		.map((m) => `${m.pid} ${m.state} ${m.args}`)
		.join("; ") || "no member listed (it exited after the check)"

/**
 * What a stopped run must not have left: running groups, open ports, registry rows, directories. A
 * group of zombies only has stopped (its reaper has not collected them yet); any running member fails.
 */
export async function residueOf(r: {
	runId: string
	pgids: Iterable<number>
	ports: Iterable<number>
	tmpDir?: string
}): Promise<string[]> {
	const left: string[] = []
	for (const g of r.pgids) if (groupAlive(g)) left.push(`process group ${g}: ${describeMembers(g)}`)
	for (const p of r.ports) if (!(await portRefuses(p))) left.push(`port ${p} accepts`)
	for (const row of registryRows()) if (ownedBy(row, r.runId)) left.push(`registry row ${row.port} ${row.owner}`)
	const dirs = [
		join(CACHE, "runs", r.runId),
		join(CACHE, "pp-env", "runs", `${r.runId}-pool`),
		join(CACHE, "bridge-sandbox", r.runId),
		...(r.tmpDir ? [r.tmpDir] : []),
	]
	for (const d of dirs) if (existsSync(d)) left.push(`dir ${d}`)
	return left
}

export const portsOwnedBy = (runId: string) =>
	registryRows()
		.filter((row) => ownedBy(row, runId))
		.map((row) => row.port)
