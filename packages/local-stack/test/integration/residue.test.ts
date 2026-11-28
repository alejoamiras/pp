import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import type { ProcFs } from "@pp/run-isolation/process-group"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { classify, isBbHelper, look, lookAtGroups, parseCmdline, residueOf, type Seen } from "./residue.ts"

const state = (pid: number) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
	} catch {
		return undefined
	}
}

// A run id nothing owns, so only the group decides the residue.
const runId = `residue-test-${process.pid}`

describe.skipIf(!existsSync("/proc/self/stat") && process.env.CI === undefined)("residueOf on a process group", () => {
	it("reads a group whose only member is an unreaped zombie as stopped", async () => {
		// The inner shell leads its own group and exits once the outer one became `sleep`, which never reaps.
		const parent = spawn("sh", ["-c", `( exec setsid sh -c 'echo $$; sleep 0.3' ) & exec sleep 30`], {
			stdio: ["ignore", "pipe", "inherit"],
		})
		try {
			const [chunk] = (await once(parent.stdout, "data")) as [Buffer]
			const pgid = Number(chunk.toString().trim())
			for (let i = 0; i < 100 && state(pgid) !== "Z"; i++) await sleep(50)
			expect(state(pgid)).toBe("Z")
			expect(await residueOf({ runId, pgids: [pgid], ports: [] })).toEqual([])
		} finally {
			parent.kill("SIGKILL")
		}
	})

	it("fails on a running member at once, naming it", async () => {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
		const pgid = child.pid as number
		try {
			expect(await residueOf({ runId, pgids: [pgid], ports: [] })).toEqual([
				expect.stringMatching(new RegExp(`^process group ${pgid}: ${pgid} [RS] sleep 30$`)),
			])
		} finally {
			process.kill(-pgid, "SIGKILL")
		}
	})
})

describe("lookAtGroups", () => {
	/**
	 * Scripted groups on a fake clock: each look returns the group's next entry (the last one repeats) and
	 * takes `cost` ms; each pause takes what it was asked for plus `late`.
	 */
	function script(looks: Record<number, Seen[]>, { late = 0, cost = 0 } = {}) {
		let clock = 0
		const order: string[] = []
		const settle = {
			boundMs: 1_000,
			now: () => clock,
			sleep: async (ms: number) => {
				order.push("pause")
				clock += ms + late
			},
			look: (g: number) => {
				order.push(`look ${g}`)
				clock += cost
				const q = looks[g] as Seen[]
				return (q.length > 1 ? q.shift() : q[0]) as Seen
			},
		}
		return { settle, order, at: () => clock }
	}
	const helpers = (n: number): Seen[] => Array(n).fill("helpers")
	let warn: ReturnType<typeof vi.spyOn>
	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})
	afterEach(() => warn.mockRestore())

	it("lets a helpers-only group empty within the bound while another waits out the bound, and logs both", async () => {
		const s = script({ 7: [...helpers(5), "gone"], 8: helpers(1) })
		expect(await lookAtGroups([8, 7], s.settle).settle()).toEqual([8])
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[residue\] group 7 emptied after 50 ms; it held /))
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[residue\] group 8 kept at the bound after 1000 ms; it held /))
		expect(s.order.slice(0, 2), "every group is looked at before any pause").toEqual(["look 8", "look 7"])
	})

	it("keeps a group seen running anything else, at the first look or any later one, even if it then empties", async () => {
		const s = script({ 1: ["running"], 2: ["helpers", "running", "gone"] })
		expect(await lookAtGroups([1, 2], s.settle).settle()).toEqual([1, 2])
		expect(s.order.filter((o) => o === "look 1")).toHaveLength(1)
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[residue\] group 2 kept at a member that is not a helper after 10 ms/))
	})

	it("keeps a group whose emptying is seen only by a look or pause that ends past the bound", async () => {
		const late = script({ 5: ["helpers", "gone"] }, { late: 995 })
		expect(await lookAtGroups([5], late.settle).settle()).toEqual([5])
		const slow = script({ 6: ["helpers", "gone"] }, { cost: 600 })
		expect(await lookAtGroups([6], slow.settle).settle(), "the bound counts from before the first look").toEqual([6])
	})
})

describe("isBbHelper, classify and look", () => {
	const bb = "/repo/node_modules/.bun/@aztec-foundation+bb.js@6.0.0/node_modules/@aztec-foundation/bb.js/build/amd64-linux/bb"
	const argv = [bb, "msgpack", "run", "--input", "bb-sync-3650-0-0.shm", "--request-ring-size", "4194304"]
	const helper = { pid: 3673, ppid: 1, argv }

	it("matches bb.js's sync helper by its exact argv once its spawner is not its parent, and nothing near it", () => {
		expect(isBbHelper(helper)).toBe(true)
		expect(isBbHelper({ ...helper, ppid: 3650 }), "its spawner is alive as its parent").toBe(false)
		const near: string[][] = [
			[...argv, "--extra"],
			argv.slice(0, -1),
			[bb.replace(/bb$/, "bbx"), ...argv.slice(1)],
			[bb.replace("amd64-linux", "anything"), ...argv.slice(1)],
			[bb.replace(/^\/repo\//, ""), ...argv.slice(1)],
			["/usr/bin/bb", ...argv.slice(1)],
			[bb, "msgpack", "run", "--input", "other.shm", "--request-ring-size", "4194304"],
			[bb, "prove", "run", "--input", "bb-sync-3650-0-0.shm", "--request-ring-size", "4194304"],
			[bb, "msgpack", "run", "--input", "bb-sync-3650-0-0.shm", "--request-ring-size", "4M"],
			[],
		]
		for (const v of near) expect(isBbHelper({ ...helper, argv: v }), v.join(" ")).toBe(false)
	})

	it("reads helpers only when no running member is anything else or the group's leader", () => {
		expect(classify(9, [helper])).toBe("helpers")
		expect(classify(3673, [helper]), "a helper that leads its group").toBe("running")
		expect(classify(9, [helper, { pid: 10, ppid: 1, argv: ["sleep", "5"] }])).toBe("running")
		expect(classify(9, [])).toBe("running")
	})

	it("parses a NUL-terminated command line exactly, keeping empty arguments", () => {
		expect(parseCmdline("a\0b\0")).toEqual(["a", "b"])
		expect(parseCmdline("a\0\0")).toEqual(["a", ""])
		expect(parseCmdline(`${argv.join("\0")}\0extra`)).toEqual([])
		expect(parseCmdline("")).toEqual([])
	})

	it("reads each running member's stat and command line from /proc in one pass", () => {
		// Above PID_MAX_LIMIT, so the kernel has no such group and only the scripted /proc speaks for it.
		const PG = 4_194_305
		const st = (pid: number, state: string, pgrp = PG) => `${pid} (x y) ${state} 1 ${pgrp} 0 0`
		const files: Record<string, string | string[]> = {
			"/proc": ["1", "100", "101", "self"],
			"/proc/1/stat": st(1, "S", 1),
			"/proc/100/stat": st(100, "Z"),
			"/proc/100/task": ["100"],
			"/proc/100/task/100/stat": st(100, "Z"),
			"/proc/101/stat": st(101, "S"),
			"/proc/101/cmdline": `${argv.join("\0")}\0`,
		}
		const proc = (edit: Record<string, string | string[] | undefined> = {}): ProcFs => {
			const f = { ...files, ...edit }
			const get = (p: string) => f[p] ?? raise(p)
			return { readdir: (p) => get(p) as string[], readFile: (p) => get(p) as string }
		}
		expect(look(PG, proc())).toBe("helpers")
		expect(look(PG, proc({ "/proc/101/cmdline": undefined })), "it exited between its stat and argv").toBe("running")
		expect(
			look(PG, proc({ "/proc/100/task": ["100", "102"], "/proc/100/task/102/stat": st(102, "S") })),
			"a zombie leader with a thread running",
		).toBe("running")
		expect(look(PG, proc({ "/proc/101/stat": undefined }))).toBe("gone")
	})
})

function raise(path: string): never {
	throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
}
