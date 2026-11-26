// Anvil plus `aztec start --local-network`, owned by one run. Adapted from Unleashed's local-network harness (Apache-2.0).
import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { claimPorts, releasePorts, releasePortsSync } from "./ports"
import { killGroup, killGroupSync, newRunId, removeRunDir, runDir, sleep, spawnGroup, TOOLCHAIN } from "./proc"

export interface LocalNetwork {
	runId: string
	anvilUrl: string
	nodeUrl: string
	stop(): Promise<void>
}

async function rpcResponds(url: string, method: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
			signal: AbortSignal.timeout(5_000),
		})
		return res.ok && ((await res.json()) as { result?: unknown }).result != null
	} catch {
		return false
	}
}

/** Fails fast when `child` exits before answering. */
async function waitHealthy(label: string, child: ChildProcess, probe: () => Promise<boolean>, timeoutMs: number): Promise<void> {
	for (const start = Date.now(); Date.now() - start < timeoutMs; await sleep(500)) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before answering`)
		if (await probe()) return
	}
	throw new Error(`${label} did not answer within ${timeoutMs} ms`)
}

export async function startLocalNetwork(): Promise<LocalNetwork> {
	const runId = newRunId("net")
	const ports = await claimPorts(runId, ["anvil", "node", "admin", "p2p"] as const)
	const anvilUrl = `http://127.0.0.1:${ports.anvil}`
	const nodeUrl = `http://127.0.0.1:${ports.node}`
	const internalBin = join(TOOLCHAIN, "internal-bin")
	const children: ReturnType<typeof spawnGroup>[] = []

	let stopping: Promise<void> | undefined
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			while (children.length > 0) await killGroup(children.pop())
			await releasePorts(runId)
			removeRunDir(runId)
		})()
		return stopping
	}
	// `on`, not `once`: `bun run` forwards a second signal, and a `once` handler let that one orphan a child.
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void stop().then(() => process.exit(130)))
	process.once("exit", () => {
		for (const child of children) killGroupSync(child)
		releasePortsSync(runId)
		removeRunDir(runId)
	})

	let dir = ""
	try {
		dir = runDir(runId)
		// Base fee 7 wei: from anvil's 1 gwei default, EIP-1559 decay drags the rollup's mana fee down ~40,000x in minutes.
		children.push(
			spawnGroup(
				join(TOOLCHAIN, "bin", "aztec-anvil"),
				["--host", "127.0.0.1", "--port", String(ports.anvil), "--chain-id", "31337", "--slots-in-an-epoch", "1"]
					.concat(["--block-base-fee-per-gas", "7", "--accounts", "10", "--silent"]),
				process.env,
				join(dir, "anvil.log"),
			),
		)
		await waitHealthy(`anvil at ${anvilUrl}`, children[0]!, () => rpcResponds(anvilUrl, "eth_chainId"), 60_000)

		const { AZTEC_DISABLE_ADMIN_API_KEY: _d, AZTEC_RESET_ADMIN_API_KEY: _r, ...inherited } = process.env
		const env: NodeJS.ProcessEnv = {
			...inherited,
			PATH: `${internalBin}:${process.env.PATH ?? ""}`,
			// Local-network mode builds node config from env and ignores --data-directory.
			DATA_DIRECTORY: join(dir, "node"),
			TMPDIR: join(dir, "tmp"),
			SEQ_MIN_TX_PER_BLOCK: "0",
			ETHEREUM_HOSTS: anvilUrl,
			// Keeps the admin API authenticated behind a hash no key matches; nothing here uses it.
			AZTEC_ADMIN_API_KEY_HASH: randomBytes(32).toString("hex"),
			// The L1 deployer resolves forge/anvil from ~/.aztec/current first unless pinned here.
			FORGE_BIN: join(internalBin, "forge"),
			ANVIL_BIN: join(internalBin, "anvil"),
			LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
		}
		children.push(
			spawnGroup(
				join(TOOLCHAIN, "node_modules", ".bin", "aztec"),
				["start", "--local-network", "--port", String(ports.node), "--admin-port", String(ports.admin)]
					.concat(["--p2p.p2pPort", String(ports.p2p), "--l1-rpc-urls", anvilUrl]),
				env,
				join(dir, "node.log"),
			),
		)
		await waitHealthy(`aztec node at ${nodeUrl}`, children[1]!, () => rpcResponds(nodeUrl, "node_getNodeInfo"), 240_000)
	} catch (e) {
		await stop()
		throw e
	}
	return { runId, anvilUrl, nodeUrl, stop }
}
