import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort, releasePorts } from "@pp/run-isolation/ports"
import { endGroup, groupAlive, type ProcFs, pidNamespace, startTime } from "@pp/run-isolation/process-group"
import { describe, expect, test } from "vitest"
import { ownedPorts } from "./owned"
import { abandonBoot, recordGroup, stopRecorded, stopStack } from "./stack-owner"

const procWith = (files: Record<string, string>): ProcFs => ({
	readdir: () => [],
	readFile: (path) => {
		const text = files[path]
		if (text === undefined) throw new Error(`ENOENT: ${path}`)
		return text
	},
})

test("recording a group on a machine without /proc fails naming the missing /proc, and writes no record", () => {
	const dir = stateDir()
	try {
		const record = join(dir, "stack.pid")
		expect(() => recordGroup(record, 4242, procWith({}))).toThrow(/this machine has no \/proc/)
		expect(existsSync(record)).toBe(false)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test("recording a group where /proc cannot show a pid is gone fails, and writes no record", () => {
	const dir = stateDir()
	try {
		const record = join(dir, "stack.pid")
		expect(() => recordGroup(record, process.pid, undefined, () => undefined)).toThrow(
			/hides processes or numbers another pid namespace/,
		)
		expect(existsSync(record)).toBe(false)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

const CLI = "/kit/local-stack/src/cli.ts"
const GRACE_MS = 10_000

/** A detached group whose leader names `CLI` in its arguments; `script` decides how long it stays. */
function fakeCli(script = "sleep 60; :"): number {
	const child = spawn("sh", ["-c", script, CLI], { detached: true, stdio: "ignore" })
	if (child.pid === undefined) throw new Error("sh did not start")
	child.unref()
	return child.pid
}

async function untilReaped(pid: number): Promise<void> {
	for (const end = Date.now() + 5_000; startTime(pid) !== undefined; ) {
		if (Date.now() > end) throw new Error(`pid ${pid} was not reaped`)
		await new Promise((r) => setTimeout(r, 20))
	}
}

function stateDir(): string {
	const base = join(homedir(), ".cache", "pp", "e2e-kit")
	mkdirSync(base, { recursive: true })
	return mkdtempSync(join(base, "stack-owner-"))
}

describe.skipIf(!existsSync("/proc/self/stat"))("down, on a live group", () => {
	test("leaves a group whose leader's start time differs from the record, and keeps the record", async () => {
		const dir = stateDir()
		const pgid = fakeCli()
		try {
			const record = join(dir, "stack.pid")
			writeFileSync(record, `${pgid} ${Number(startTime(pgid)) + 1} ${pidNamespace()}\n`)
			await stopRecorded(record, CLI, GRACE_MS)
			expect(groupAlive(pgid)).toBe(true)
			expect(existsSync(record)).toBe(true)
		} finally {
			await endGroup(pgid, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("leaves a live group recorded under another pid namespace, and keeps the record", async () => {
		const dir = stateDir()
		const pgid = fakeCli()
		try {
			const record = join(dir, "stack.pid")
			recordGroup(record, pgid, undefined, () => "another-boot/pid:[1]/")
			await stopRecorded(record, CLI, GRACE_MS)
			expect(groupAlive(pgid)).toBe(true)
			expect(existsSync(record)).toBe(true)
		} finally {
			await endGroup(pgid, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("ends a recorded group whose leader is gone while a member it left keeps running, and drops the record", async () => {
		const dir = stateDir()
		const pgid = fakeCli("sleep 60 & :")
		try {
			const record = join(dir, "stack.pid")
			recordGroup(record, pgid)
			await untilReaped(pgid)
			expect(groupAlive(pgid)).toBe(true)
			await stopRecorded(record, CLI, GRACE_MS)
			expect(groupAlive(pgid)).toBe(false)
			expect(existsSync(record)).toBe(false)
		} finally {
			await endGroup(pgid, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("ends the group it recorded at spawn while the CLI has logged nothing yet, and drops the record", async () => {
		const dir = stateDir()
		const pgid = fakeCli()
		try {
			const record = join(dir, "stack.pid")
			recordGroup(record, pgid)
			expect(existsSync(join(dir, "stack.log"))).toBe(false)
			await stopRecorded(record, CLI, GRACE_MS)
			expect(groupAlive(pgid)).toBe(false)
			expect(existsSync(record)).toBe(false)
		} finally {
			await endGroup(pgid, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe.skipIf(!existsSync("/proc/self/stat"))("a boot that failed", () => {
	const boot = (recorded: boolean, unreaped: boolean) => ({ recorded, unreaped, cli: CLI, graceMs: GRACE_MS })

	test("leaves a recorded pgid that a stranger now leads, and keeps the record", async () => {
		const dir = stateDir()
		const stranger = fakeCli()
		try {
			const record = join(dir, "stack.pid")
			// The CLI exited and was reaped; its pid now names another process.
			writeFileSync(record, `${stranger} ${Number(startTime(stranger)) + 1} ${pidNamespace()}\n`)
			await abandonBoot(record, stranger, boot(true, false))
			expect(groupAlive(stranger)).toBe(true)
			expect(existsSync(record)).toBe(true)
		} finally {
			await endGroup(stranger, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("ends the recorded group while it is still the CLI's, and drops the record", async () => {
		const dir = stateDir()
		const pgid = fakeCli()
		try {
			const record = join(dir, "stack.pid")
			recordGroup(record, pgid)
			await abandonBoot(record, pgid, boot(true, false))
			expect(groupAlive(pgid)).toBe(false)
			expect(existsSync(record)).toBe(false)
		} finally {
			await endGroup(pgid, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("with no record written, signals the group only while the CLI is unreaped", async () => {
		const dir = stateDir()
		const pgid = fakeCli()
		try {
			const record = join(dir, "stack.pid")
			await abandonBoot(record, pgid, boot(false, false))
			expect(groupAlive(pgid)).toBe(true)
			await abandonBoot(record, pgid, boot(false, true))
			expect(groupAlive(pgid)).toBe(false)
		} finally {
			await endGroup(pgid, GRACE_MS)
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

const listen = (port: number) =>
	new Promise<Server>((resolve, reject) => {
		const server = createServer()
		server.once("error", reject)
		server.listen(port, "127.0.0.1", () => resolve(server))
	})
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))

describe.skipIf(!existsSync("/proc/self/stat"))("down, once the group is gone", () => {
	/** A state dir with a private registry, one claimed port with a listener, and its snapshot. */
	async function held() {
		const dir = stateDir()
		const saved = process.env.PP_PORTS_REGISTRY
		process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
		const owner = `stack-owner-test-${process.pid}`
		const port = await claimPort(owner, "node")
		const server = await listen(port)
		const f = { pid: join(dir, "stack.pid"), owned: join(dir, "stack-owned.json"), log: join(dir, "stack.log") }
		writeFileSync(f.owned, JSON.stringify(ownedPorts([port])))
		const free = async () => {
			if (server.listening) await close(server)
			await releasePorts(owner)
		}
		const done = async () => {
			await free()
			if (saved === undefined) delete process.env.PP_PORTS_REGISTRY
			else process.env.PP_PORTS_REGISTRY = saved
			rmSync(dir, { recursive: true, force: true })
		}
		return { f, owner, port, free, done }
	}

	test("fails while a port the stack held is still held, keeps the record, and passes on a later down once nothing is", async () => {
		const h = await held()
		const cli = fakeCli()
		try {
			recordGroup(h.f.pid, cli)
			// The CLI's group ends cleanly, but a service it started still listens and its row stays.
			await expect(stopStack(h.f, CLI, GRACE_MS, 0)).rejects.toThrow(
				`stack: its group is gone, but a listener is still on port ${h.port}; ports.md still has rows owned by ${h.owner}`,
			)
			expect(groupAlive(cli)).toBe(false)
			// No pid left for the later down to resolve: the kernel may hand that number out again.
			expect(readFileSync(h.f.pid, "utf8")).toBe("gone\n")
			await expect(stopStack(h.f, CLI, GRACE_MS, 0)).rejects.toThrow(`a listener is still on port ${h.port}`)
			await h.free()
			await stopStack(h.f, CLI, GRACE_MS, 0)
			expect(existsSync(h.f.pid)).toBe(false)
		} finally {
			await endGroup(cli, GRACE_MS)
			await h.done()
		}
	})

	test("waits out leftovers that clear within the settle window", async () => {
		const h = await held()
		const cli = fakeCli()
		try {
			recordGroup(h.f.pid, cli)
			setTimeout(() => void h.free(), 500)
			await stopStack(h.f, CLI, GRACE_MS, 10_000)
			expect(existsSync(h.f.pid)).toBe(false)
		} finally {
			await endGroup(cli, GRACE_MS)
			await h.done()
		}
	})

	test("fails the first down on the CLI's own teardown-failed line, not on the marker inside another line", async () => {
		const h = await held()
		const clean = fakeCli()
		const failed = fakeCli()
		try {
			await h.free()
			writeFileSync(h.f.log, "[stack] circuits /x/[stack] teardown failed: y\n[stack] ready\n")
			recordGroup(h.f.pid, clean)
			await stopStack(h.f, CLI, GRACE_MS, 0)
			expect(existsSync(h.f.pid)).toBe(false)
			writeFileSync(h.f.log, "[stack] ready\n[stack] teardown failed: aztec: pgid 7 survived SIGKILL\n")
			recordGroup(h.f.pid, failed)
			await expect(stopStack(h.f, CLI, GRACE_MS, 0)).rejects.toThrow("the CLI reported a failed teardown")
			// The report has failed a run; a later down checks only what is still held.
			await stopStack(h.f, CLI, GRACE_MS, 0)
			expect(existsSync(h.f.pid)).toBe(false)
		} finally {
			await endGroup(clean, GRACE_MS)
			await endGroup(failed, GRACE_MS)
			await h.done()
		}
	})

	test("fails on a record it cannot resolve, and signals nothing", async () => {
		const h = await held()
		const stranger = fakeCli()
		try {
			writeFileSync(h.f.pid, `${stranger} ${Number(startTime(stranger)) + 1} ${pidNamespace()}\n`)
			await expect(stopStack(h.f, CLI, GRACE_MS, 0)).rejects.toThrow("names no group this kit can stop")
			expect(groupAlive(stranger)).toBe(true)
			writeFileSync(h.f.pid, "not a record\n")
			await expect(stopStack(h.f, CLI, GRACE_MS, 0)).rejects.toThrow("names no group this kit can stop")
		} finally {
			await endGroup(stranger, GRACE_MS)
			await h.done()
		}
	})
})
