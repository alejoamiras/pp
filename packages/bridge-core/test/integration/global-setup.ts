/** Boots the sandbox once for the whole suite and hands every file the JSON handle. Attaches to
 *  a running network when `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` are set (a `sandbox:up` kept
 *  alive), which is how a developer iterates without paying the boot per run. */
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { TestProject } from "vitest/node"
import { deployEverything } from "../../scripts/sandbox/deploy"
import type { SandboxHandle } from "../../scripts/sandbox/handle"
import { assertNothingLeft, SANDBOX_CACHE_DIR, startLocalNetwork } from "../../scripts/sandbox/local-network"

declare module "vitest" {
	export interface ProvidedContext {
		handle: SandboxHandle
	}
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	if (!process.env.BRIDGE_INTEGRATION)
		throw new Error("set BRIDGE_INTEGRATION=1 (the test:integration script does) — this suite boots a live network")
	const runId = `bridge-integration-${process.pid}-${Date.now().toString(36)}`
	const net = await startLocalNetwork({ runId })
	// A caller-named directory is the caller's to keep; one this run made goes with the network.
	const named = process.env.PP_SANDBOX_ARTIFACTS
	const artifactsDir = named ?? join(SANDBOX_CACHE_DIR, `${runId}-artifacts`)
	mkdirSync(artifactsDir, { recursive: true })
	const teardown = async () => {
		await net.stop()
		if (!named) rmSync(artifactsDir, { recursive: true, force: true })
		assertNothingLeft(net)
	}
	try {
		const { handle } = await deployEverything(net, { artifactsDir })
		project.provide("handle", handle)
	} catch (e) {
		await teardown()
		throw e
	}
	return teardown
}
