import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort } from "@pp/run-isolation/ports"
import { type CleanupStack, killGroup, type OwnedChild, spawnOwned } from "@pp/run-isolation/process"
import { hostOf, httpRpc, type Rpc } from "./rpc.ts"

/** The repository's Foundry pin. Aztec's bundled anvil is newer and is never used for the fork. */
export const FOUNDRY_VERSION = "1.7.1"
/** What that anvil answers to `web3_clientVersion`; writers refuse a node that answers anything else. */
export const ANVIL_CLIENT_VERSION = `anvil/v${FOUNDRY_VERSION}`

/** The first `tool` reporting the pinned version: on `PATH` (CI installs it there), then the repository's tool cache. */
export function resolveFoundry(
	tool: "anvil" | "forge",
	candidates = [Bun.which(tool), join(homedir(), `.cache/pp/tools/foundry-${FOUNDRY_VERSION}/${tool}`)],
): string {
	const tried: string[] = []
	for (const bin of candidates) {
		if (!bin || !existsSync(bin)) continue
		const first = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? ""
		if (first === `${tool} Version: ${FOUNDRY_VERSION}`) return bin
		tried.push(`${bin} (${first || "no version"})`)
	}
	throw new Error(`no ${tool} ${FOUNDRY_VERSION} found; tried ${tried.join(", ") || "nothing"}. Install Foundry ${FOUNDRY_VERSION}.`)
}

export const resolveAnvil = (candidates?: (string | null)[]) => resolveFoundry("anvil", candidates)

export interface ForkAnvil {
	/** The loopback URL of the anvil this run spawned; the only URL a writer binds to. */
	url: string
	rpc: Rpc
	owned: OwnedChild
}

type StartOptions = {
	endpoint: string
	block: bigint
	runId: string
	/** Holds the anvil's log; the run owns and removes it. */
	dataDir: string
	cleanup: CleanupStack
	/** Called with the group's id as soon as it exists, so a caller can check the group is gone even if startup fails. */
	onSpawn?: (pgid: number) => void
	bin?: string
}

/**
 * Spawns the fork as its own process group on a claimed loopback port, with its teardown on `cleanup`.
 * Anvil 1.7.1 takes the endpoint only in argv, which other local users can read through `/proc`;
 * acceptable for a keyless endpoint only.
 */
export async function startForkAnvil(o: StartOptions): Promise<ForkAnvil> {
	const port = await claimPort(o.runId, "fork-anvil")
	const args = [
		["--fork-url", o.endpoint],
		["--fork-block-number", String(o.block)],
		["--host", "127.0.0.1"],
		["--port", String(port)],
		// The endpoint's state is read once per run and never cached across runs, so a stale cache cannot pass.
		["--no-storage-caching"],
		// Free endpoints rate-limit bursts of log queries; these retries absorbed them in measurement.
		["--retries", "8"],
		["--fork-retry-backoff", "1000"],
		["--timeout", "60000"],
		// Quiet, so the endpoint never reaches the log.
		["--silent"],
	].flat()
	const owned = spawnOwned(
		o.bin ?? resolveAnvil(),
		args,
		join(o.dataDir, "anvil.log"),
		{ PATH: process.env.PATH ?? "", HOME: o.dataDir },
		{ release: [{ port, service: "fork-anvil", owner: o.runId }] },
	)
	o.cleanup.push(async () => {
		if (!(await killGroup(owned))) throw new Error(`fork anvil's process group ${owned.child.pid} survived SIGKILL`)
	})
	if (owned.child.pid !== undefined) o.onSpawn?.(owned.child.pid)
	const url = `http://127.0.0.1:${port}`
	const rpc = httpRpc(url, { hide: [o.endpoint] })
	await ready(rpc, owned, hostOf(o.endpoint))
	return { url, rpc, owned }
}

async function ready(rpc: Rpc, owned: OwnedChild, upstream: string, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (owned.hasExited()) throw new Error(`the fork of ${upstream} exited before it served: ${owned.exitReason()}`)
		const up = await rpc("eth_blockNumber").then(
			() => true,
			() => false,
		)
		if (up) return
		if (Date.now() > deadline) throw new Error(`the fork of ${upstream} did not serve within ${timeoutMs} ms`)
		await Bun.sleep(250)
	}
}
