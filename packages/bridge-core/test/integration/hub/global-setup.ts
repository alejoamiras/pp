/** Boots one local network for the hub suite and hands its URLs to every file. It never attaches to
 *  a running one: the suite counts blocks and Outbox depths, which another client's transactions
 *  on a shared network would change. */
import type { TestProject } from "vitest/node"
import { assertNothingLeft, startLocalNetwork } from "../../../scripts/sandbox/local-network"

export interface HubNetwork {
	anvilUrl: string
	nodeUrl: string
}

declare module "vitest" {
	export interface ProvidedContext {
		hubNetwork: HubNetwork
	}
}

const ATTACH_VARS = ["SANDBOX_L1_RPC", "SANDBOX_NODE_URL"] as const

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const inherited = ATTACH_VARS.filter((name) => process.env[name])
	if (inherited.length > 0) throw new Error(`unset ${inherited.join(" and ")}: the hub suite runs only on a network it boots itself`)
	const net = await startLocalNetwork({ runId: `hub-network-${process.pid}-${Date.now().toString(36)}` })
	project.provide("hubNetwork", { anvilUrl: net.anvilUrl, nodeUrl: net.nodeUrl })
	return async () => {
		await net.stop()
		try {
			assertNothingLeft(net)
		} catch (e) {
			// vitest 4 logs a teardown error as "error during close" and still exits 0.
			process.exitCode = 1
			throw e
		}
	}
}
