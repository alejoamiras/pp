/**
 * What a real-wallet run owns, written while the stack is live, and the check that none of it
 * survives the run: the owned ports (`scripts/e2e/owned.ts`), plus the wallet's browser profile and
 * the run's `real-wallet/` directory.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type OwnedPorts, ownedPorts, portLeftovers } from "../scripts/e2e/owned"

export interface Owned extends OwnedPorts {
	profileDir: string
}

export const ownedFile = (stateDir: string) => join(stateDir, "real-wallet-owned.json")

/** @param knownPorts the run's ports from `ports.json` and the stack's handle or manifest */
export function snapshotOwned(stateDir: string, knownPorts: number[], profileDir: string): Owned {
	const owned: Owned = { ...ownedPorts(knownPorts), profileDir }
	writeFileSync(ownedFile(stateDir), JSON.stringify(owned, null, 2))
	return owned
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

/** Everything of the run still alive or claimed, as readable lines; empty means clean. */
export function leftovers(stateDir: string): string[] {
	const file = ownedFile(stateDir)
	if (!existsSync(file)) {
		const booted = existsSync(join(stateDir, "sandbox.log")) || existsSync(join(stateDir, "stack.log"))
		return booted ? ["no owned-inventory snapshot although a stack was started: cleanup cannot be certified"] : []
	}
	const o = JSON.parse(readFileSync(file, "utf8")) as Owned
	const out = portLeftovers(o)
	const procs = processesNaming(o.profileDir).filter((pid) => pid !== process.pid)
	if (procs.length > 0) out.push(`processes still name the wallet profile: ${procs.join(", ")}`)
	if (existsSync(join(stateDir, "real-wallet"))) out.push(`${join(stateDir, "real-wallet")} still exists`)
	return out
}
