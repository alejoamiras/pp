import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { once } from "node:events"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it } from "vitest"
import { endGroup, groupAlive } from "./process-group"

const linux = existsSync("/proc/self/stat") && spawnSync("setsid", ["--version"]).status === 0

const state = (pid: number) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
	} catch {
		return undefined
	}
}

describe.skipIf(!linux)("groupAlive", () => {
	it("counts a group whose only member is a zombie nobody has reaped as gone", async () => {
		// The inner shell leads its own group and exits after the outer one became `sleep`, which never reaps.
		const parent = spawn("sh", ["-c", `( exec setsid sh -c 'echo $$; sleep 0.3' ) & exec sleep 30`], {
			stdio: ["ignore", "pipe", "inherit"],
		})
		try {
			const [chunk] = (await once(parent.stdout, "data")) as [Buffer]
			const pgid = Number(chunk.toString().trim())
			for (let i = 0; i < 100 && state(pgid) !== "Z"; i++) await sleep(50)
			expect(state(pgid)).toBe("Z")
			expect(() => process.kill(-pgid, 0)).not.toThrow()
			expect(groupAlive(pgid)).toBe(false)
			expect(await endGroup(pgid, 100)).toBe(true)
		} finally {
			parent.kill("SIGKILL")
		}
	})
})
