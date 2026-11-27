import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { killGroup, spawnOwned } from "./process.ts"
import { groupAlive, signalGroup } from "./process-group.ts"

const parent = join(homedir(), ".cache/pp/run-isolation")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "process-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PROCESS_TS = JSON.stringify(join(import.meta.dir, "process.ts"))

async function until(path: string, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`${path} never appeared`)
		await Bun.sleep(20)
	}
}

test("a command that cannot start ends with exit code 127 and says why in its log", async () => {
	const log = join(dir, "missing.log")
	const owned = spawnOwned(join(dir, "no-such-anvil"), [], log, {})
	await owned.exited
	expect(owned.exitReason()).toBe("exit code 127")
	expect(readFileSync(log, "utf8")).toContain(`could not start ${join(dir, "no-such-anvil")}`)
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

test("killGroup ends the members a group keeps after its leader has exited", async () => {
	// An ignored signal stays ignored across exec, so only SIGKILL ends the orphaned sleep.
	const ready = join(dir, "orphan-ready")
	const script = `(trap '' TERM; echo > "$READY"; exec sleep 30) & exit 0`
	const owned = spawnOwned("sh", ["-c", script], join(dir, "orphan.log"), { PATH: process.env.PATH ?? "", READY: ready })
	await owned.exited
	await until(ready)
	const pgid = owned.child.pid as number
	try {
		expect(groupAlive(pgid)).toBe(true)
		expect(await killGroup(owned)).toBe(true)
		expect(groupAlive(pgid)).toBe(false)
	} finally {
		signalGroup(pgid, "SIGKILL")
	}
})

test("killGroup calls while one is under way share it, so the leader gets one SIGTERM", async () => {
	const [ready, marks, release] = ["terms-ready", "terms", "terms-release"].map((f) => join(dir, f))
	// The leader counts each SIGTERM and stays up until released, so the second call lands mid-teardown.
	const script = `trap 'echo t >> "$MARKS"' TERM; echo > "$READY"; while [ ! -e "$RELEASE" ]; do sleep 0.05; done`
	const env = { PATH: process.env.PATH ?? "", READY: ready, MARKS: marks, RELEASE: release }
	const owned = spawnOwned("sh", ["-c", script], join(dir, "terms.log"), env)
	await until(ready)
	const first = killGroup(owned)
	await until(marks)
	expect(killGroup(owned)).toBe(first)
	writeFileSync(release, "")
	expect(await first).toBe(true)
	expect(readFileSync(marks, "utf8").trim().split("\n")).toEqual(["t"])
})
