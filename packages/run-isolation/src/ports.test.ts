import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort, claimRows, portOwner, registeredPorts, releasePorts, releaseRows, rowsOwnedBy } from "./ports.ts"

const parent = join(homedir(), ".cache/pp/run-isolation")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "ports-test-"))
const saved = process.env.PP_PORTS_REGISTRY
beforeAll(() => {
	process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
})
afterAll(() => {
	if (saved === undefined) delete process.env.PP_PORTS_REGISTRY
	else process.env.PP_PORTS_REGISTRY = saved
	rmSync(dir, { recursive: true, force: true })
})

test(
	"release outlasts a dead holder's lock instead of returning with its rows intact",
	async () => {
		const runId = "ports-test-release"
		await claimPort(runId, "pp-env-test")
		expect(rowsOwnedBy(runId)).toBe(1)
		// A holder that died 7 s ago: its lock turns stale 8 s into the wait, so only a wait past the stale threshold frees it.
		const lock = join(dir, "ports.md.lock")
		writeFileSync(lock, "")
		const diedAt = (Date.now() - 7_000) / 1000
		utimesSync(lock, diedAt, diedAt)
		await releasePorts(runId)
		expect(rowsOwnedBy(runId)).toBe(0)
	},
	{ timeout: 30_000 },
)

test("release drops only the rows its run owns, even when a run ID equals another row's service", async () => {
	await claimPort("ports-test-other", "pp-env-anvil")
	await claimPort("pp-env-anvil", "pp-env-test")
	await releasePorts("pp-env-anvil")
	expect(rowsOwnedBy("ports-test-other")).toBe(1)
	await releasePorts("ports-test-other")
})

test("release leaves a row whose owner only contains the run id, and one that names it in another column", async () => {
	const runId = "ports-test-exact"
	await claimRows(`${runId}-pool`, { anvil: 40_001 }, process.pid)
	await claimRows("ports-test-neighbour", { [runId]: 40_002 }, process.pid)
	await claimRows(runId, { anvil: 40_003 }, process.pid)
	expect(await releaseRows(runId)).toBe(true)
	expect([rowsOwnedBy(runId), rowsOwnedBy(`${runId}-pool`), rowsOwnedBy("ports-test-neighbour")]).toEqual([0, 1, 1])
	await releasePorts(`${runId}-pool`)
	await releasePorts("ports-test-neighbour")
})

test("a claim refuses an owner or service a release could not match", async () => {
	for (const [owner, service] of [
		["run ", "anvil"],
		["run", "a|b"],
		["run\nx", "anvil"],
	] as const)
		await expect(claimRows(owner, { [service]: 40_010 }, process.pid)).rejects.toThrow("cannot be a registry cell")
	expect(registeredPorts().has(40_010)).toBe(false)
})

test("a claim writes the rows it checked, though the caller's object changes while it waits for the lock", async () => {
	const lock = join(dir, "ports.md.lock")
	writeFileSync(lock, "held")
	const rows: Record<string, number> = { "pp-env-test": 40_011 }
	const claim = claimRows("ports-test-snapshot", rows, process.pid)
	rows["a|b"] = 40_012
	rmSync(lock)
	await claim
	expect([40_011, 40_012].filter((p) => registeredPorts().has(p))).toEqual([40_011])
	await releasePorts("ports-test-snapshot")
})

test("a port's owner is the run whose row lists it, until that run releases it", async () => {
	const port = await claimPort("ports-test-owner", "pp-env-test")
	expect(portOwner(port)).toBe("ports-test-owner")
	await releasePorts("ports-test-owner")
	expect(portOwner(port)).toBeUndefined()
})
