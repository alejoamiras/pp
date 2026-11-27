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
}

export const ownedFile = (stateDir: string) => join(stateDir, "real-wallet-owned.json")

/** @param knownPorts the run's ports from `ports.json` and the stack's handle or manifest */
export function snapshotOwned(stateDir: string, knownPorts: number[], profileDir: string): Owned {
	const owners = [...new Set(knownPorts.map(portOwner).filter((o): o is string => o !== undefined))]
	const ports = [...new Set([...knownPorts, ...owners.flatMap(portsOwnedBy)])].sort((a, b) => a - b)
	const owned = { owners, ports, profileDir }
	writeFileSync(ownedFile(stateDir), JSON.stringify(owned, null, 2))
	return owned
}

/** TCP and UDP ports with a listener on this host, any user. */
export function listeningPorts(): Set<number> {
	const out = execFileSync("ss", ["-ltnuH"], { encoding: "utf8" })
	const ports = new Set<number>()
	for (const line of out.split("\n")) {
		const local = line.trim().split(/\s+/)[4] ?? ""
		const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 10)
		if (Number.isInteger(port)) ports.add(port)
	}
	return ports
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
 * A port a different owner has claimed since is theirs, not a leak.
 */
export function leftovers(stateDir: string): string[] {
	const file = ownedFile(stateDir)
	if (!existsSync(file)) {
		const booted = existsSync(join(stateDir, "sandbox.log")) || existsSync(join(stateDir, "stack.log"))
		return booted ? ["no owned-inventory snapshot although a stack was started: cleanup cannot be certified"] : []
	}
	const o = JSON.parse(readFileSync(file, "utf8")) as Owned
	const out: string[] = []
	const live = listeningPorts()
	for (const port of o.ports) {
		const owner = portOwner(port)
		if (live.has(port) && (owner === undefined || o.owners.includes(owner))) out.push(`a listener is still on port ${port}`)
	}
	for (const owner of o.owners) if (rowsOwnedBy(owner) > 0) out.push(`ports.md still has rows owned by ${owner}`)
	const procs = processesNaming(o.profileDir).filter((pid) => pid !== process.pid)
	if (procs.length > 0) out.push(`processes still name the wallet profile: ${procs.join(", ")}`)
	if (existsSync(join(stateDir, "real-wallet"))) out.push(`${join(stateDir, "real-wallet")} still exists`)
	return out
}
