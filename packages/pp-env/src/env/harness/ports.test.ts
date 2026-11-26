import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort, releasePorts, rowsOwnedBy } from "./ports.ts"

const parent = join(homedir(), ".cache/pp/pp-env")
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

test("a CleanupStack built with signals: false installs no signal handler", async () => {
	const probe = (signals: string) =>
		`import { CleanupStack } from ${JSON.stringify(join(import.meta.dir, "process.ts"))}
		new CleanupStack(${signals}); console.log(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"))`
	const run = async (signals: string) => {
		const p = Bun.spawn(["bun", "-e", probe(signals)], { stdout: "pipe", stderr: "inherit" })
		return (await new Response(p.stdout).text()).trim()
	}
	expect(await run("{ signals: false }")).toBe("0 0")
	expect(await run("")).toBe("1 1")
})
