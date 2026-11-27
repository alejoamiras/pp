import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it, vi } from "vitest"
import { classify, isBbHelper, lookAtGroups, parseCmdline, residueOf, type Seen } from "./residue.ts"

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
	/** A scripted group: each look returns the next entry, and each pause advances the clock by what it was asked for plus `late`. */
	function script(looks: Record<number, Seen[]>, late = 0) {
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
				return (looks[g] as Seen[]).length > 1 ? ((looks[g] as Seen[]).shift() as Seen) : ((looks[g] as Seen[])[0] as Seen)
			},
		}
		return { settle, order, at: () => clock }
	}
	const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {})

	it("lets a helpers-only group empty within the bound, and logs the wait", async () => {
		const warn = quiet()
		try {
			const s = script({ 7: ["helpers", "helpers", "helpers", "helpers", "helpers", "gone"] })
			expect(await lookAtGroups([7], s.settle).settle()).toEqual([])
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[residue\] group 7 emptied after 50 ms; it held /))
		} finally {
			warn.mockRestore()
		}
	})

	it("keeps a group seen running anything else, at the first look or any later one, even if it then empties", async () => {
		const warn = quiet()
		try {
			const s = script({ 1: ["running"], 2: ["helpers", "running", "gone"] })
			expect(await lookAtGroups([1, 2], s.settle).settle()).toEqual([1, 2])
			expect(s.order.filter((o) => o === "look 1")).toHaveLength(1)
			expect(warn).toHaveBeenCalledWith(
				expect.stringMatching(/^\[residue\] group 2 kept at a member that is not a helper after 10 ms/),
			)
		} finally {
			warn.mockRestore()
		}
	})

	it("keeps a helper not seen gone by the bound, a late pause included, and looks at every group before waiting", async () => {
		const warn = quiet()
		try {
			const s = script({ 3: ["helpers"], 4: ["helpers"] })
			expect(await lookAtGroups([3, 4], s.settle).settle()).toEqual([3, 4])
			expect(s.order.slice(0, 2)).toEqual(["look 3", "look 4"])
			expect(s.at()).toBeLessThanOrEqual(1_000)
			const late = script({ 5: ["helpers", "gone"] }, 995)
			expect(await lookAtGroups([5], late.settle).settle(), "a look after the bound proves nothing").toEqual([5])
		} finally {
			warn.mockRestore()
		}
	})
})

describe("isBbHelper and classify", () => {
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
})
