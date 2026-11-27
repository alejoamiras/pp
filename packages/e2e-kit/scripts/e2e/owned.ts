/**
 * The ports a run owns, captured while its services are live, and the check that none of them
 * survives its teardown. A stack's teardown deletes its manifest before it stops its services, and
 * the sandbox claims ports (the node's admin and P2P) the manifest never names, so the snapshot is
 * every port claimed by every registry owner found on a known port, taken before teardown begins.
 */
import { execFileSync } from "node:child_process"
import { portOwner, portsOwnedBy, rowsOwnedBy } from "@pp/run-isolation/ports"

export interface OwnedPorts {
	owners: string[]
	ports: number[]
	/** The pids listening on each owned port when the snapshot was taken. */
	listeners: Record<number, number[]>
}

/** Read off the text, since `URL` drops a port that is its scheme's default, as on `http://127.0.0.1:80`. */
const LOOPBACK_URL = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:[/?#]|$)/

/** Every loopback port an `http(s)` or `ws(s)` URL with an explicit port anywhere in `v` names. */
export function loopbackPorts(v: unknown, out: Set<number> = new Set()): Set<number> {
	if (typeof v === "string") {
		const port = Number(LOOPBACK_URL.exec(v)?.[1])
		if (port >= 1 && port <= 65535) out.add(port)
	} else if (v && typeof v === "object") for (const x of Object.values(v)) loopbackPorts(x, out)
	return out
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

/** @param knownPorts ports the run is known to hold, each of which may lead to a registry owner */
export function ownedPorts(knownPorts: Iterable<number>): OwnedPorts {
	const known = [...knownPorts]
	const owners = [...new Set(known.map(portOwner).filter((o): o is string => o !== undefined))]
	const ports = [...new Set([...known, ...owners.flatMap(portsOwnedBy)])].sort((a, b) => a - b)
	const live = listeners()
	const held: Record<number, number[]> = {}
	for (const p of ports) {
		const pids = live.get(p)
		if (pids) held[p] = pids
	}
	return { owners, ports, listeners: held }
}

/**
 * The owned ports whose listener is the run's: the port's registry row is still one of the run's
 * owners, or the row is gone and a process that listened there at the snapshot still does. A port
 * nobody listened on at the snapshot cannot be attributed and counts as the run's.
 */
export function leakedListeners(o: OwnedPorts, live: Map<number, number[]>, ownerOf: (port: number) => string | undefined): number[] {
	return o.ports.filter((port) => {
		const now = live.get(port)
		if (!now) return false
		const owner = ownerOf(port)
		if (owner !== undefined) return o.owners.includes(owner)
		const then = o.listeners[port] ?? []
		return then.length === 0 || now.some((pid) => then.includes(pid))
	})
}

/**
 * The run's listeners and registry rows still alive, as readable lines; empty means clean. A port a
 * different owner has claimed since, or a stranger bound after the run released it, is not a leak.
 */
export function portLeftovers(o: OwnedPorts): string[] {
	const out = leakedListeners(o, listeners(), portOwner).map((port) => `a listener is still on port ${port}`)
	for (const owner of o.owners) if (rowsOwnedBy(owner) > 0) out.push(`ports.md still has rows owned by ${owner}`)
	return out
}
