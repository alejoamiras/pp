import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
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

/** How long a group alive only through bb.js helpers gets to empty: ten times their own 100 ms backstop. */
export const SETTLE_MS = 1_000

/**
 * bb.js's sync helper, by its exact argv: `<pkg>/build/<platform>/bb msgpack run --input bb-sync-…shm
 * --request-ring-size <n>`. Importing `@aztec-labs/foundation/crypto/sync` spawns it in the importer's
 * group. It stops itself on its spawner's death (PR_SET_PDEATHSIG), but its SIGTERM handler only sets a
 * flag, so it can sleep out one 100 ms wait first: it always outlives its spawner, by up to that.
 */
export function isBbHelper(argv: readonly string[]): boolean {
	const [bin, sub, run, input, shm, ring, size, ...extra] = argv
	return (
		/\/@aztec-foundation\/bb\.js\/build\/[a-z0-9-]+\/bb$/.test(bin ?? "") &&
		sub === "msgpack" &&
		run === "run" &&
		input === "--input" &&
		/^bb-sync-\d+-\d+-\d+\.shm$/.test(shm ?? "") &&
		ring === "--request-ring-size" &&
		/^\d+$/.test(size ?? "") &&
		extra.length === 0
	)
}

function argvOf(pid: number): string[] {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1)
	} catch {
		return []
	}
}

/** Whether every running member of `pgid` is a helper, none of them its leader: so its spawner is gone. */
function helpersOnly(pgid: number, helper: (argv: readonly string[]) => boolean): boolean {
	const running = groupMembers(pgid).filter((m) => m.state !== "Z" && m.state !== "X")
	return running.length > 0 && running.every((m) => m.pid !== pgid && helper(argvOf(m.pid)))
}

export type Settle = { boundMs?: number; helper?: (argv: readonly string[]) => boolean }

/**
 * The groups of `pgids` still running once each group alive only through helpers has had up to
 * `boundMs` to empty; any other running member fails at once. Every wait is logged with what it saw
 * and how long it took, so a slow exit is an observation, not a pass in silence.
 */
export async function settledGroups(pgids: Iterable<number>, o: Settle = {}): Promise<number[]> {
	const [bound, helper] = [o.boundMs ?? SETTLE_MS, o.helper ?? isBbHelper]
	const left: number[] = []
	for (const g of pgids) {
		if (!groupAlive(g)) continue
		if (!helpersOnly(g, helper)) {
			left.push(g)
			continue
		}
		const [seen, started] = [describeMembers(g), performance.now()]
		while (groupAlive(g) && helpersOnly(g, helper) && performance.now() - started < bound) await sleep(10)
		const [ms, running] = [Math.round(performance.now() - started), groupAlive(g)]
		if (running) left.push(g)
		console.warn(`[residue] group ${g} ${running ? "still running" : "emptied"} after ${ms} ms; it held ${seen}`)
	}
	return left
}

/**
 * What a stopped run must not have left: running groups, open ports, registry rows, directories. A
 * group of zombies only has stopped (its reaper has not collected them yet); any running member fails,
 * except bb.js helpers, which get {@link SETTLE_MS} to follow their spawner. The rest is read at once.
 */
export async function residueOf(r: {
	runId: string
	pgids: Iterable<number>
	ports: Iterable<number>
	tmpDir?: string
	settle?: Settle
}): Promise<string[]> {
	const left: string[] = []
	for (const g of await settledGroups(r.pgids, r.settle)) left.push(`process group ${g}: ${describeMembers(g)}`)
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
