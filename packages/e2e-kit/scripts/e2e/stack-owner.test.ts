import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { endGroup, groupAlive, type ProcFs } from "@pp/run-isolation/process-group"
import { describe, expect, test } from "vitest"
import { recordGroup, startTime, stopRecorded } from "./stack-owner"

/** A stat line whose fields after the command name run state, 4, 5, … with `start` as field 22. */
const statLine = (comm: string, state: string, start: string) =>
	`4242 (${comm}) ${[state, ...Array.from({ length: 18 }, (_, i) => String(i + 4)), start, "23", "24"].join(" ")}\n`

const procWith = (files: Record<string, string>): ProcFs => ({
	readdir: () => [],
	readFile: (path) => {
		const text = files[path]
		if (text === undefined) throw new Error(`ENOENT: ${path}`)
		return text
	},
})

test("the start time is field 22 as text, past a command name holding ') (' and spaces, a zombie's included", () => {
	const at = (stat: string) => startTime(4242, procWith({ "/proc/4242/stat": stat }))
	expect(at(statLine("a) (b c", "S", "0012345"))).toBe("0012345")
	expect(at(statLine("cli.ts", "Z", "98765"))).toBe("98765")
	expect(startTime(4242, procWith({}))).toBeUndefined()
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

const CLI = "/kit/local-stack/src/cli.ts"
const GRACE_MS = 10_000

/** A detached group whose leader names `CLI` in its arguments and stays until signalled. */
function fakeCli(): number {
	const child = spawn("sh", ["-c", "sleep 60; :", CLI], { detached: true, stdio: "ignore" })
	if (child.pid === undefined) throw new Error("sh did not start")
	child.unref()
	return child.pid
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
			writeFileSync(record, `${pgid} ${Number(startTime(pgid)) + 1}\n`)
			await stopRecorded(record, CLI, GRACE_MS)
			expect(groupAlive(pgid)).toBe(true)
			expect(existsSync(record)).toBe(true)
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
