import { existsSync } from "node:fs"
import { join } from "node:path"
import { entriesPaused, type UnopenedBridge } from "@pp/bridge-core/deploy"
import { expect, test } from "vitest"
import { newRunId, RUNS_DIR } from "../../src/run-dir.ts"
import { bootStack } from "../../src/stack.ts"
import { portsOwnedBy, processTree, residueOf, sampleTree } from "./residue.ts"

const OTHER_POOL = "0x000000000000000000000000000000000000dead"

test("L1 a failed bridge read-back keeps entries paused, writes no manifest and leaves nothing behind", async () => {
	const runId = newRunId()
	const tree = sampleTree(process.pid, new Set(processTree(process.pid).map((p) => p.pgid)))
	const ports = new Set<number>()
	const portTimer = setInterval(() => {
		for (const p of portsOwnedBy(runId)) ports.add(p)
	}, 250)
	const steps: string[] = []
	let failed: { bridge: UnopenedBridge; paused: boolean } | undefined
	try {
		await expect(
			bootStack(
				{ runId, onStep: ({ step }) => void steps.push(step) },
				{
					bridgeExpectations: (e) => ({ ...e, pool: OTHER_POOL }),
					onBridgeFailure: async (bridge) => {
						failed = { bridge, paused: await entriesPaused(bridge) }
					},
				},
			),
		).rejects.toThrow(/implementation\.POOL is 0x[0-9a-fA-F]{40}, expected 0x0+dead/)
	} finally {
		tree.stop()
		clearInterval(portTimer)
	}
	expect(failed?.paused).toBe(true)
	expect(failed?.bridge.stopped).toBe(true)
	expect(steps).toEqual(["network", "pool"])
	expect(existsSync(join(RUNS_DIR, runId, "manifest.json"))).toBe(false)
	expect(ports.size).toBeGreaterThan(0)
	expect(await residueOf({ runId, pgids: tree.pgids, ports })).toEqual([])
})
