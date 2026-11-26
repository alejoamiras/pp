import { join } from "node:path"
import type { TestProject } from "vitest/node"
import { type LocalNetwork, startLocalNetwork } from "../harness/local-network"
import { CACHE_ROOT } from "../harness/proc"

declare module "vitest" {
	export interface ProvidedContext {
		nodeUrl: string
		anvilUrl: string
		runId: string
	}
}

let network: LocalNetwork | undefined

export async function setup(project: TestProject): Promise<void> {
	network = await startLocalNetwork()
	console.log(`RUN_ID=${network.runId} NODE_URL=${network.nodeUrl}`)
	// Workers fork after this hook and inherit it: ephemeral wallet stores land in the run's directory, on real disk.
	process.env.TMPDIR = join(CACHE_ROOT, network.runId, "tmp")
	project.provide("nodeUrl", network.nodeUrl)
	project.provide("anvilUrl", network.anvilUrl)
	project.provide("runId", network.runId)
}

export async function teardown(): Promise<void> {
	await network?.stop()
}
