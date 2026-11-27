/**
 * One loopback port claimed in the host registry (`~/.agents/ports.md`) through the sandbox harness's
 * helpers, so every other run on the host picks around it from the moment it is chosen. Candidates
 * come from below the kernel's ephemeral range, which an outgoing connection's source port never
 * takes between the bind test and the listen.
 */
import { readFileSync } from "node:fs"
import { createServer } from "node:net"
import { PortClaimConflict, registeredPorts, registerHostPorts, releaseHostPorts } from "@pp/bridge-core/sandbox"

const STATIC_LO = 10_000
const FLOOR_GUARD = 512
const TRIES = 256

function ephemeralFloor(): number {
	try {
		const lo = Number.parseInt(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0] ?? "", 10)
		return Number.isFinite(lo) && lo > STATIC_LO + 256 ? lo : 32_768
	} catch {
		return 32_768
	}
}

function bindable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer()
		srv.unref()
		srv.once("error", () => resolve(false))
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)))
	})
}

async function candidate(taken: Set<number>): Promise<number> {
	const span = ephemeralFloor() - FLOOR_GUARD - STATIC_LO
	for (let i = 0; i < TRIES; i++) {
		const port = STATIC_LO + Math.floor(Math.random() * span)
		if (!taken.has(port) && (await bindable(port))) return port
	}
	throw new Error("ports: no free loopback port in the static window")
}

export interface ClaimedPort {
	readonly port: number
	/** Drops this claim's registry row; never throws. */
	release(): Promise<void>
}

export async function claimPort(service: string): Promise<ClaimedPort> {
	const runId = `web-${service}-${process.pid}-${Date.now().toString(36)}`
	for (let attempt = 0; ; attempt++) {
		const port = await candidate(registeredPorts())
		try {
			await registerHostPorts(runId, "web", { [service]: port }, process.pid)
			return { port, release: () => releaseHostPorts(runId, { [service]: port }) }
		} catch (e) {
			if (!(e instanceof PortClaimConflict) || attempt >= 4) throw e
		}
	}
}
