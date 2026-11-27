import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { groupAlive, groupMembers, type ProcFs } from "@pp/run-isolation/process-group"

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

const BB_BIN = /^\/(?:[^/]+\/)*@aztec-foundation\/bb\.js\/build\/(?:amd64|arm64)-(?:linux|macos)\/bb$/

export type Member = { pid: number; ppid: number; argv: readonly string[] }

/**
 * bb.js's sync helper by its exact argv, once the spawner its ring names (`bb-sync-<pid>-…`) is not its
 * parent. Importing `@aztec-labs/foundation/crypto/sync` spawns it in the importer's group. Its spawner's
 * death sends it SIGTERM (PR_SET_PDEATHSIG), whose handler only sets a flag, so it can sleep out one
 * 100 ms wait before it exits.
 */
export function isBbHelper(m: Member): boolean {
	const [bin, sub, run, input, ring, flag, size, ...extra] = m.argv
	const spawner = /^bb-sync-(\d+)-\d+-\d+\.shm$/.exec(ring ?? "")?.[1]
	return (
		BB_BIN.test(bin ?? "") &&
		sub === "msgpack" &&
		run === "run" &&
		input === "--input" &&
		spawner !== undefined &&
		Number(spawner) !== m.ppid &&
		flag === "--request-ring-size" &&
		/^\d+$/.test(size ?? "") &&
		extra.length === 0
	)
}

/** A `/proc/<pid>/cmdline` as argv; one not ending in NUL (a zombie's empty one included) is `[]`. */
export const parseCmdline = (raw: string): string[] => (raw.endsWith("\0") ? raw.slice(0, -1).split("\0") : [])

const HOST: ProcFs = { readdir: (p) => readdirSync(p), readFile: (p) => readFileSync(p, "utf8") }

function stat(path: string, proc: ProcFs): { state: string; ppid: number; pgrp: number } | undefined {
	let s: string
	try {
		s = proc.readFile(path)
	} catch {
		return undefined
	}
	const f = s.slice(s.lastIndexOf(")") + 2).split(" ")
	return { state: f[0] ?? "", ppid: Number(f[1]), pgrp: Number(f[2]) }
}

const ended = (state: string | undefined) => state === undefined || state === "Z" || state === "X"

/** A zombie still runs while one of its threads does: a leader whose main thread returned first. */
function runs(pid: string, state: string, proc: ProcFs): boolean {
	if (!ended(state)) return true
	try {
		return proc.readdir(`/proc/${pid}/task`).some((t) => !ended(stat(`/proc/${pid}/task/${t}/stat`, proc)?.state))
	} catch {
		return false
	}
}

/**
 * The running members of `pgid` in one pass, each one's command line read right after its stat, so a
 * helper that exits mid-pass is either listed whole or not at all. One that vanishes between the two
 * reads has an empty argv and so counts as a member that is not a helper.
 */
function runningMembers(pgid: number, proc: ProcFs): Member[] {
	const out: Member[] = []
	for (const pid of proc.readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue
		const st = stat(`/proc/${pid}/stat`, proc)
		if (st?.pgrp !== pgid || !runs(pid, st.state, proc)) continue
		let raw = ""
		try {
			raw = proc.readFile(`/proc/${pid}/cmdline`)
		} catch {}
		out.push({ pid: Number(pid), ppid: st.ppid, argv: parseCmdline(raw) })
	}
	return out
}

export type Seen = "gone" | "helpers" | "running"

/** `helpers` when every running member is a bb.js helper and none leads the group. */
export const classify = (pgid: number, running: readonly Member[]): Exclude<Seen, "gone"> =>
	running.length > 0 && running.every((m) => m.pid !== pgid && isBbHelper(m)) ? "helpers" : "running"

/** A pass that lists no running member defers to `groupAlive`; a member only it finds was never classified, so it counts as running. */
export function look(pgid: number, proc: ProcFs = HOST): Seen {
	const running = runningMembers(pgid, proc)
	if (running.length > 0) return classify(pgid, running)
	return groupAlive(pgid, proc) ? "running" : "gone"
}

export type Settle = {
	boundMs?: number
	look?: (pgid: number) => Seen
	now?: () => number
	sleep?: (ms: number) => Promise<unknown>
}

type Outcome = "gone" | "a member that is not a helper" | "the bound"

/**
 * Looks at every group of `pgids` now. `settle()` then gives the groups seen alive only through helpers
 * until `boundMs` after the first look began to be seen gone, looking at all of them every 10 ms, and
 * resolves to the groups kept: those seen running anything else at any look, or not seen gone by a look
 * that ended within the bound. Every wait is logged with what it saw and how long it took, so a slow exit
 * is an observation rather than a silent pass.
 */
export function lookAtGroups(pgids: Iterable<number>, o: Settle = {}): { settle(): Promise<number[]> } {
	const { boundMs = SETTLE_MS, look: see = look, now = () => performance.now(), sleep: pause = sleep } = o
	const start = now()
	const deadline = start + boundMs
	const first = [...pgids].map((g) => ({ g, seen: see(g), held: describeMembers(g) }))
	const held = new Map(first.map((f) => [f.g, f.held]))
	// Read after the look it judges, so a look that ends past the deadline counts as the bound.
	const OUTCOME: Record<Seen, Outcome | undefined> = { gone: "gone", running: "a member that is not a helper", helpers: undefined }
	const decide = (seen: Seen) => (now() >= deadline ? "the bound" : OUTCOME[seen])
	return {
		async settle() {
			const kept = first.filter((f) => f.seen === "running").map((f) => f.g)
			const decided = new Map<number, [Outcome, number]>()
			let pending = first.filter((f) => f.seen === "helpers").map((f) => f.g)
			const judge = (seen: (g: number) => Seen) => {
				for (const g of pending) {
					const d = decide(seen(g))
					if (d) decided.set(g, [d, now()])
				}
				pending = pending.filter((g) => !decided.has(g))
			}
			judge(() => "helpers")
			while (pending.length > 0) {
				await pause(Math.max(0, Math.min(10, deadline - now())))
				judge(see)
			}
			for (const [g, [outcome, at]] of decided) {
				if (outcome !== "gone") kept.push(g)
				const what = outcome === "gone" ? "emptied" : `kept at ${outcome}`
				console.warn(`[residue] group ${g} ${what} after ${Math.round(at - start)} ms; it held ${held.get(g)}`)
			}
			return kept
		},
	}
}

/**
 * What a stopped run must not have left: running groups, open ports, registry rows, directories. A
 * group of zombies only has stopped (its reaper has not collected them yet); any running member fails,
 * except bb.js helpers, which get {@link SETTLE_MS} to follow their spawner. Groups are looked at and
 * the rest is read before that wait, so nothing else gets it.
 */
export async function residueOf(r: {
	runId: string
	pgids: Iterable<number>
	ports: Iterable<number>
	tmpDir?: string
	settle?: Settle
}): Promise<string[]> {
	const groups = lookAtGroups(r.pgids, r.settle)
	const rest: string[] = []
	for (const p of r.ports) if (!(await portRefuses(p))) rest.push(`port ${p} accepts`)
	for (const row of registryRows()) if (ownedBy(row, r.runId)) rest.push(`registry row ${row.port} ${row.owner}`)
	const dirs = [
		join(CACHE, "runs", r.runId),
		join(CACHE, "pp-env", "runs", `${r.runId}-pool`),
		join(CACHE, "bridge-sandbox", r.runId),
		...(r.tmpDir ? [r.tmpDir] : []),
	]
	for (const d of dirs) if (existsSync(d)) rest.push(`dir ${d}`)
	const kept = (await groups.settle()).map((g) => `process group ${g}: ${describeMembers(g)}`)
	return [...kept, ...rest]
}

export const portsOwnedBy = (runId: string) =>
	registryRows()
		.filter((row) => ownedBy(row, runId))
		.map((row) => row.port)
