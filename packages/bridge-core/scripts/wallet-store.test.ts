import { type ChildProcess, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { pidNamespace } from "@pp/run-isolation/process-group"
import { storeRoot } from "./wallet-store"

const module = join(import.meta.dirname, "wallet-store.ts")
const keepAlive = "setInterval(() => {}, 1000);"
const disk = join(homedir(), ".cache", "pp", "wallet-stores")
/** Above Linux's largest `pid_max` (2^22), so no process here ever has it. */
const NO_SUCH_PID = 4_194_305

/** A child that takes a store and prints its path; `before` runs first, `after` keeps it alive or not. */
function child(
	before: string,
	after: string,
	env: Record<string, string> = {},
): { proc: ChildProcess; lines: string[]; exited: Promise<number | null> } {
	const body = `${before} const { ownedWalletStore } = await import(${JSON.stringify(module)}); console.log(ownedWalletStore("test", { sandboxKeysOnly: true })); ${after}`
	const proc = spawn("bun", ["-e", body], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } })
	const lines: string[] = []
	proc.stdout?.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)))
	const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)))
	return { proc, lines, exited }
}

/** The store path, once the child has printed it. */
async function storeOf(lines: string[]): Promise<string> {
	while (lines.length === 0) await new Promise((r) => setTimeout(r, 10))
	return lines[0] as string
}

/** A store directory named as if `pid`, started at `start` under namespace `tag`, owned it. */
function plant(tag: string, pid: number, start: string, files = 1, root = disk): string {
	mkdirSync(root, { recursive: true, mode: 0o700 })
	const dir = mkdtempSync(join(root, `pp-test-${tag}-${pid}-${start}-`))
	for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}`), "x")
	return dir
}

describe("ownedWalletStore", () => {
	it("removes the store when the process exits", async () => {
		const c = child("", "")
		const dir = await storeOf(c.lines)
		expect(await c.exited).toBe(0)
		expect(dir).toMatch(/pp[-/\\]test-/)
		expect(existsSync(dir)).toBe(false)
	})

	it("removes the store when a signal ends the process", async () => {
		const c = child("", keepAlive)
		const dir = await storeOf(c.lines)
		expect(existsSync(dir)).toBe(true)
		c.proc.kill("SIGTERM")
		expect(await c.exited).toBe(143)
		expect(existsSync(dir)).toBe(false)
	})

	it("leaves a signal to an earlier async handler, then removes the store on its exit", async () => {
		const reaper = `process.once("SIGTERM", async () => { await new Promise((r) => setTimeout(r, 200)); console.log("reaped"); process.exit(0) });`
		const c = child(reaper, keepAlive)
		const dir = await storeOf(c.lines)
		c.proc.kill("SIGTERM")
		expect(await c.exited).toBe(0)
		expect(c.lines).toContain("reaped")
		expect(existsSync(dir)).toBe(false)
	})
})

// Nothing is reaped where /proc cannot vouch for an owner (hidepid, an ancestor's /proc); CI's runners can.
const reaps = pidNamespace() !== undefined || process.env.CI !== undefined
describe.skipIf(process.platform !== "linux" || !reaps)("a new store removes the stores of owners that are gone", () => {
	/** This host's namespace tag, read from the name of a store a child takes and drops. */
	async function ownTag(): Promise<string> {
		const c = child("", "")
		const name = basename(await storeOf(c.lines))
		await c.exited
		return /^pp-test-([0-9a-f]{12})-\d+-\d+-/.exec(name)?.[1] as string
	}

	it("removes a SIGKILLed owner's store and keeps a live owner's", async () => {
		const [killed, live] = [child("", keepAlive), child("", keepAlive)]
		const [killedDir, liveDir] = [await storeOf(killed.lines), await storeOf(live.lines)]
		killed.proc.kill("SIGKILL")
		await killed.exited
		expect(existsSync(killedDir), "SIGKILL skips the exit handler").toBe(true)
		const next = child("", "")
		await storeOf(next.lines)
		expect(await next.exited).toBe(0)
		expect(existsSync(killedDir)).toBe(false)
		expect(existsSync(liveDir)).toBe(true)
		live.proc.kill("SIGTERM")
		await live.exited
	})

	it("removes a store whose pid now names another process, and leaves one from another pid namespace", async () => {
		const tag = await ownTag()
		// This test process is alive, but did not start at tick 1: its pid was handed out again.
		const reused = plant(tag, process.pid, "1")
		const gone = plant(tag, NO_SUCH_PID, "1")
		const foreign = plant(tag === "0".repeat(12) ? "f".repeat(12) : "0".repeat(12), NO_SUCH_PID, "1")
		const next = child("", "")
		await storeOf(next.lines)
		expect(await next.exited).toBe(0)
		expect(existsSync(reused)).toBe(false)
		expect(existsSync(gone)).toBe(false)
		expect(existsSync(foreign), "an owner in another container cannot be seen from here").toBe(true)
		rmSync(foreign, { recursive: true, force: true })
	})

	it("leaves a root another user could write in, so nothing in it can be swapped before removal", async () => {
		const home = mkdtempSync(join(homedir(), ".cache", "pp", "wallet-home-"))
		try {
			const root = join(home, ".cache", "pp", "wallet-stores")
			const dead = plant(await ownTag(), NO_SUCH_PID, "1", 1, root)
			const take = async () => {
				const next = child("", "", { HOME: home })
				await storeOf(next.lines)
				expect(await next.exited).toBe(0)
			}
			chmodSync(root, 0o775)
			await take()
			expect(existsSync(dead)).toBe(true)
			chmodSync(root, 0o700)
			await take()
			expect(existsSync(dead)).toBe(false)
		} finally {
			rmSync(home, { recursive: true, force: true })
		}
	})

	it("lets creators that race to remove the same dead store all take their own", async () => {
		const dead = plant(await ownTag(), NO_SUCH_PID, "1", 3_000)
		const go = join(disk, `pp-test-go-${process.pid}`)
		// Each racer has its module loaded and waits on one go file, so all of them reap at once.
		const barrier = `const { existsSync } = await import("node:fs"); await import(${JSON.stringify(module)}); console.log("ready"); while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);`
		const racers = Array.from({ length: 4 }, () => child(barrier, ""))
		try {
			while (!racers.every((r) => r.lines.includes("ready"))) await new Promise((r) => setTimeout(r, 10))
			writeFileSync(go, "")
			expect(await Promise.all(racers.map((r) => r.exited))).toEqual([0, 0, 0, 0])
		} finally {
			rmSync(go, { force: true })
		}
		expect(racers.every((r) => r.lines.length === 2)).toBe(true)
		expect(existsSync(dead)).toBe(false)
	})
})

describe("storeRoot", () => {
	it("puts a store of sandbox keys on real disk", () => {
		expect(storeRoot({ sandboxKeysOnly: true })).toBe(disk)
	})

	it.skipIf(process.platform !== "linux")("puts real keys on /dev/shm where it is a tmpfs", () => {
		expect(storeRoot({ sandboxKeysOnly: false })).toBe("/dev/shm")
	})

	it("refuses real keys where shm is not a tmpfs", () => {
		expect(() => storeRoot({ sandboxKeysOnly: false, shm: import.meta.dirname })).toThrow(/not a tmpfs/)
	})
})
