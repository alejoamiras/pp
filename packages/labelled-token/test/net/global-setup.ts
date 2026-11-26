/** Boots one local network for the suite and hands every file its URLs. Attaches instead when
 *  `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` name a running one. */
import { assertNothingLeft, startLocalNetwork } from "@pp/bridge-core/sandbox"
import type { TestProject } from "vitest/node"

declare module "vitest" {
	export interface ProvidedContext {
		nodeUrl: string
		anvilUrl: string
	}
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	if (!process.env.TOKEN_NET) throw new Error("set TOKEN_NET=1 (the test:net script does): this suite boots a live network")
	// The `tok-` prefix names this suite's port rows and data directory, so a gate can prove none outlive it.
	const net = await startLocalNetwork({ runId: `tok-${process.pid}-${Date.now().toString(36)}` })
	project.provide("nodeUrl", net.nodeUrl)
	project.provide("anvilUrl", net.anvilUrl)
	return async () => {
		await net.stop()
		assertNothingLeft(net)
	}
}
