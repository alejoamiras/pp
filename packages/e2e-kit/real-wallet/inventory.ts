/**
 * What a run owns, written while the stack is live, and the check that none of it survives the run.
 * The stack's own teardown deletes its manifest before it stops its services, and the sandbox claims
 * ports (the node's admin and P2P) the manifest never names, so the inventory is every port claimed
 * by every registry owner found on a known port, captured before teardown begins.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { portOwner, portsOwnedBy, rowsOwnedBy } from "@pp/run-isolation/ports"

export interface Owned {
	owners: string[]
	ports: number[]
	profileDir: string
	/** The pids listening on each owned port when the snapshot was taken. */
	listeners: Record<number, number[]>
}

export const ownedFile = (stateDir: string) => join(stateDir, "real-wallet-owned.json")

/** @param knownPorts the run's ports from `ports.json` and the stack's handle or manifest */
export function snapshotOwned(stateDir: string, knownPorts: number[], profileDir: string): Owned {
	const owners = [...new Set(knownPorts.map(portOwner).filter((o): o is string => o !== undefined))]
	const ports = [...new Set([...knownPorts, ...owners.flatMap(portsOwnedBy)])].sort((a, b) => a - b)
	const live = listeners()
	const held: Record<number, number[]> = {}
	for (const p of ports) {
		const pids = live.get(p)
		if (pids) held[p] = pids
	}
	const owned: Owned = { owners, ports, profileDir, listeners: held }
	writeFileSync(ownedFile(stateDir), JSON.stringify(owned, null, 2))
	return owned
}

/** Each listening TCP or UDP port in `ss -ltnupH` output, with the pids it names (only this user's). */
export function parseListeners(ss: string): Map<number, number[]> {
	const out = new Map<number, number[]>()
	for (const line of ss.split("\n")) {
		const local = line.trim().split(/\s+/)[4] ?? ""
		const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 10)
		if (!Number.isInteger(port)) continue
		out.set(port, [...(out.get(port) ?? []), ...Array.from(line.matchAll(/,pid=(\d+),/g), (m) => Number(m[1]))])
	}
	return out
}

const listeners = () => parseListeners(execFileSync("ss", ["-ltnupH"], { encoding: "utf8" }))

/**
 * The owned ports whose listener is the run's: the port's registry row is still one of the run's
 * owners, or the row is gone and a process that listened there at the snapshot still does. A port
 * nobody listened on at the snapshot cannot be attributed and counts as the run's.
 */
export function leakedListeners(o: Owned, live: Map<number, number[]>, ownerOf: (port: number) => string | undefined): number[] {
	return o.ports.filter((port) => {
		const now = live.get(port)
		if (!now) return false
		const owner = ownerOf(port)
		if (owner !== undefined) return o.owners.includes(owner)
		const then = o.listeners[port] ?? []
		return then.length === 0 || now.some((pid) => then.includes(pid))
	})
}

export function processesNaming(needle: string): number[] {
	const pids: number[] = []
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue
		try {
			if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(needle)) pids.push(Number(entry))
		} catch {
			// The process ended between the listing and the read.
		}
	}
	return pids
}

/**
 * Everything of the run still alive or claimed, as readable lines; empty means clean.
 * A port a different owner has claimed since, or a stranger bound after the run released it, is not a leak.
 */
export function leftovers(stateDir: string): string[] {
	const file = ownedFile(stateDir)
	if (!existsSync(file)) {
		const booted = existsSync(join(stateDir, "sandbox.log")) || existsSync(join(stateDir, "stack.log"))
		return booted ? ["no owned-inventory snapshot although a stack was started: cleanup cannot be certified"] : []
	}
	const o = JSON.parse(readFileSync(file, "utf8")) as Owned
	const out: string[] = []
	for (const port of leakedListeners(o, listeners(), portOwner)) out.push(`a listener is still on port ${port}`)
	for (const owner of o.owners) if (rowsOwnedBy(owner) > 0) out.push(`ports.md still has rows owned by ${owner}`)
	const procs = processesNaming(o.profileDir).filter((pid) => pid !== process.pid)
	if (procs.length > 0) out.push(`processes still name the wallet profile: ${procs.join(", ")}`)
	if (existsSync(join(stateDir, "real-wallet"))) out.push(`${join(stateDir, "real-wallet")} still exists`)
	return out
}
