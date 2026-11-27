import { spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const ids: string[] = []
const runDir = (id: string) => join(homedir(), ".cache", "pp", "runs", id)

afterEach(() => {
	for (const id of ids.splice(0)) rmSync(runDir(id), { recursive: true, force: true })
})

/** Runs with-stack over the fake stack; `onLine` sees its output and can signal it. */
function withStack(mode: string, commands: string[], onLine?: (line: string, pid: number) => void) {
	const id = `wstest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
	ids.push(id)
	const boot = JSON.stringify(["bun", join(HERE, "fixtures", "fake-stack.ts"), id, mode])
	const child = spawn("bun", [join(HERE, "with-stack.ts"), ...commands], {
		env: { ...process.env, PP_WITH_STACK_BOOT: boot },
		stdio: ["ignore", "pipe", "pipe"],
	})
	let output = ""
	const read = (chunk: Buffer) => {
		output += chunk.toString()
		for (const line of chunk.toString().split("\n")) if (line) onLine?.(line, child.pid!)
	}
	child.stdout.on("data", read)
	child.stderr.on("data", read)
	return new Promise<{ code: number | null; output: string; id: string }>((resolve) =>
		child.once("exit", (code) => resolve({ code, output, id })),
	)
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** Runs `command` (which prints `child <pid>`), sending SIGTERM to the wrapper once the pid shows if `term`. */
async function withChild(command: string, term: boolean) {
	let child = 0
	const started = Date.now()
	const r = await withStack("ready", [command], (line, pid) => {
		const m = line.match(/^child (\d+)$/)
		if (!m || child) return
		child = Number(m[1])
		if (term) process.kill(pid, "SIGTERM")
	})
	return { ...r, child, ms: Date.now() - started }
}

describe("with-stack", () => {
	it("stops the command and the stack on SIGTERM to the wrapper, exiting 143 with nothing left", async () => {
		let sent = false
		const r = await withStack("ready", ["sleep 30"], (line, pid) => {
			if (!sent && line.includes("[with-stack] sleep 30")) {
				sent = true
				process.kill(pid, "SIGTERM")
			}
		})
		expect(r.code).toBe(143)
		expect(r.output).not.toContain("residue")
		expect(existsSync(runDir(r.id))).toBe(false)
	}, 30_000)

	it.each([
		["a child its shell started", "sleep 300 & echo child $!; wait"],
		["a shell that ignores SIGTERM", "trap '' TERM; echo child $$; while :; do sleep 1; done"],
	])(
		"on SIGTERM ends the command's whole group, %s included, within the grace period",
		async (_, command) => {
			const r = await withChild(command, true)
			expect(r.code).toBe(143)
			expect(r.child).toBeGreaterThan(0)
			expect(alive(r.child)).toBe(false)
			expect(r.output).not.toContain("residue")
			expect(r.ms).toBeLessThan(20_000)
		},
		30_000,
	)

	it("lets a process the command started finish exiting before calling it residue", async () => {
		const r = await withStack("ready", ["sleep 0.5 &"])
		expect(r.code).toBe(0)
		expect(r.output).not.toContain("residue")
	}, 30_000)

	it("kills and reports a process a command leaves behind when it exits", async () => {
		const r = await withChild("sleep 300 & echo child $!", false)
		expect(r.code).toBe(1)
		expect(r.output).toContain(`residue: command group`)
		expect(alive(r.child)).toBe(false)
	}, 30_000)

	it("still checks residue when the stack fails before it is ready", async () => {
		const r = await withStack("early-exit", ["true"])
		expect(r.code).toBe(1)
		expect(r.output).toContain(`residue: dir ${runDir(r.id)}`)
	}, 30_000)

	it("drops a leading --, exits with the failing command's code, and reports what a stack leaked", async () => {
		expect((await withStack("ready", ["--", "exit 3"])).code).toBe(3)
		const leaked = await withStack("leak", ["true"])
		expect(leaked.code).toBe(1)
		expect(leaked.output).toContain("residue: dir")
	}, 30_000)
})
