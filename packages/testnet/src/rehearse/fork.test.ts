import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"

const { releasePorts } = vi.hoisted(() => ({ releasePorts: vi.fn(async (_runId: string) => {}) }))

// No network: the live client answers one block and the fork fails to start.
vi.mock("viem", async (actual) => ({
	...(await actual<typeof import("viem")>()),
	createPublicClient: () => ({ getBlock: async () => ({ number: 1n }) }),
}))
vi.mock("@pp/sepolia-fork/anvil", () => ({
	startForkAnvil: async () => {
		throw new Error("the fork did not start")
	},
}))
vi.mock("@pp/pp-env/sepolia", () => ({ sepoliaPoolUser: vi.fn() }))
vi.mock("@pp/run-isolation/ports", async (actual) => ({
	...(await actual<typeof import("@pp/run-isolation/ports")>()),
	releasePorts,
}))

const { forkRehearsal } = await import("./fork")

describe("a failed fork rehearsal", () => {
	it("releases its port rows and deletes its scratch home, keeping its logs", async () => {
		const runId = `pp-testnet-rehearse-${process.pid}`
		const dir = join(homedir(), ".cache", "pp", "testnet", "rehearse", runId)
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
		const lines: string[] = []
		await expect(forkRehearsal((l) => lines.push(l))).rejects.toThrow("the fork did not start")
		expect(releasePorts).toHaveBeenCalledWith(runId)
		expect([existsSync(dir), existsSync(join(dir, "home"))]).toEqual([true, false])
		expect(lines.at(-1)).toMatch(/scratch home .* deleted/)
	})
})
