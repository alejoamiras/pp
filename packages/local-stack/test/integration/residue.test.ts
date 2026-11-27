import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it, vi } from "vitest"
import { isBbHelper, residueOf } from "./residue.ts"

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

	/** A group whose leader has exited, leaving one `sleep <s>` behind in it. */
	async function orphaned(seconds: string): Promise<number> {
		const leader = spawn("sh", ["-c", `sleep ${seconds} & exit 0`], { detached: true, stdio: "ignore" })
		await once(leader, "exit")
		return leader.pid as number
	}
	const sleeper = (seconds: string) => (argv: readonly string[]) => argv.join(" ") === `sleep ${seconds}`

	it("lets a group alive only through a helper empty within the bound, and logs the wait", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const pgid = await orphaned("0.05")
			expect(await residueOf({ runId, pgids: [pgid], ports: [], settle: { helper: sleeper("0.05") } })).toEqual([])
			expect(warn).toHaveBeenCalledWith(
				expect.stringMatching(new RegExp(`^\\[residue\\] group ${pgid} emptied after \\d+ ms; it held \\d+ S sleep 0\\.05$`)),
			)
		} finally {
			warn.mockRestore()
		}
	})

	it("fails a helper still running at the bound, and any other member at once, naming them", async () => {
		const helper = await orphaned("5")
		const other = await orphaned("6")
		try {
			const started = performance.now()
			expect(await residueOf({ runId, pgids: [other], ports: [], settle: { boundMs: 300, helper: sleeper("5") } })).toEqual([
				expect.stringMatching(new RegExp(`^process group ${other}: \\d+ S sleep 6$`)),
			])
			expect(performance.now() - started).toBeLessThan(300)
			expect(await residueOf({ runId, pgids: [helper], ports: [], settle: { boundMs: 300, helper: sleeper("5") } })).toEqual([
				expect.stringMatching(new RegExp(`^process group ${helper}: \\d+ S sleep 5$`)),
			])
			expect(performance.now() - started).toBeGreaterThanOrEqual(300)
		} finally {
			for (const g of [helper, other]) process.kill(-g, "SIGKILL")
		}
	})
})

describe("isBbHelper", () => {
	const bb = "/repo/node_modules/.bun/@aztec-foundation+bb.js@6.0.0/node_modules/@aztec-foundation/bb.js/build/amd64-linux/bb"
	const argv = [bb, "msgpack", "run", "--input", "bb-sync-3650-0-0.shm", "--request-ring-size", "4194304"]

	it("matches bb.js's sync helper by its exact argv and nothing near it", () => {
		expect(isBbHelper(argv)).toBe(true)
		const near: string[][] = [
			[...argv, "--extra"],
			argv.slice(0, -1),
			[bb.replace(/bb$/, "bbx"), ...argv.slice(1)],
			["/usr/bin/bb", ...argv.slice(1)],
			[bb, "msgpack", "run", "--input", "other.shm", "--request-ring-size", "4194304"],
			[bb, "prove", "run", "--input", "bb-sync-3650-0-0.shm", "--request-ring-size", "4194304"],
			[bb, "msgpack", "run", "--input", "bb-sync-3650-0-0.shm", "--request-ring-size", "4M"],
			[],
		]
		for (const v of near) expect(isBbHelper(v), v.join(" ")).toBe(false)
	})
})
