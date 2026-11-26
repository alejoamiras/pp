import type { TestProject } from "vitest/node"
import { assertNothingLeft, startLocalNetwork } from "../../../scripts/sandbox/local-network"

declare module "vitest" {
	export interface ProvidedContext {
		nodeUrl: string
		/** True when the network is someone else's: the suite must not warp its clock. */
		attached: boolean
	}
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	if (!process.env.BRIDGE_INTEGRATION)
		throw new Error("set BRIDGE_INTEGRATION=1 (the test:registry script does) — this suite boots a live network")
	const attached = Boolean(process.env.SANDBOX_NODE_URL)
	const runId = process.env.ASP_REGISTRY_RUN_ID ?? `asp-registry-${process.pid}-${Date.now().toString(36)}`
	const net = await startLocalNetwork({ runId })
	project.provide("nodeUrl", net.nodeUrl)
	project.provide("attached", attached)
	return async () => {
		await net.stop()
		assertNothingLeft(net)
	}
}
