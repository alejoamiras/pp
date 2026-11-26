import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnOwned } from "./process.ts"

const parent = join(homedir(), ".cache/pp/pp-env")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "process-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PROCESS_TS = JSON.stringify(join(import.meta.dir, "process.ts"))

test("a command that cannot start ends with a reason instead of an uncaught error", async () => {
	const owned = spawnOwned(join(dir, "no-such-anvil"), [], join(dir, "missing.log"), {})
	await owned.exited
	expect(owned.exitReason()).toContain("could not start")
})

test("a signal during stop() waits for the whole teardown, and a repeat does not cut it short", async () => {
	const marks = join(dir, "marks")
	const script = `import { appendFileSync } from "node:fs"
	import { CleanupStack } from ${PROCESS_TS}
	const stack = new CleanupStack()
	for (const name of ["pushed-first", "pushed-last"])
		stack.push(async () => { await Bun.sleep(300); appendFileSync(process.env.MARKS, name + "\\n") })
	void stack.run().catch(() => {})
	console.log("stopping")
	setInterval(() => {}, 1_000)`
	const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit", env: { ...process.env, MARKS: marks } })
	await p.stdout.getReader().read()
	p.kill("SIGTERM")
	await Bun.sleep(100)
	p.kill("SIGTERM")
	await p.exited
	expect(p.signalCode).toBe("SIGTERM")
	expect(readFileSync(marks, "utf8").trim().split("\n")).toEqual(["pushed-last", "pushed-first"])
})

test("a CleanupStack built with signals: false installs no signal handler", async () => {
	const probe = (signals: string) =>
		`import { CleanupStack } from ${PROCESS_TS}
		new CleanupStack(${signals}); console.log(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"))`
	const run = async (signals: string) => {
		const p = Bun.spawn(["bun", "-e", probe(signals)], { stdout: "pipe", stderr: "inherit" })
		return (await new Response(p.stdout).text()).trim()
	}
	expect(await run("{ signals: false }")).toBe("0 0")
	expect(await run("")).toBe("1 1")
})
