import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it } from "vitest"
import { residueOf } from "./residue.ts"

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
