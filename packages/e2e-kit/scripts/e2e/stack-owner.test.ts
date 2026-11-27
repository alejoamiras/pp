import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { endGroup, groupAlive, type ProcFs, pidNamespace, startTime } from "@pp/run-isolation/process-group"
import { describe, expect, test } from "vitest"
import { recordGroup, stopRecorded } from "./stack-owner"

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
