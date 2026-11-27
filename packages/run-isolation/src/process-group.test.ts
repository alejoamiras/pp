import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, readlinkSync } from "node:fs"
import { once } from "node:events"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, expect, it } from "bun:test"
import { endGroup, groupAlive, pidNamespace, type ProcFs, type ProcLinks, startTime } from "./process-group"

// Without /proc these semantics do not apply (macOS); CI is Linux, so there the suite always runs.
const proc = existsSync("/proc/self/stat") || process.env.CI !== undefined
const requireTool = (cmd: string) => expect(spawnSync(cmd, ["--version"]).status, `${cmd} is required`).toBe(0)

// The main thread leaves through the raw exit syscall (not exit_group), so its worker keeps running.
const LONE_WORKER = `
import ctypes, os, threading, time
ready = threading.Event()
threading.Thread(target=lambda: (ready.set(), time.sleep(30))).start()
ready.wait()
print(os.getpid(), flush=True)
ctypes.CDLL(None).syscall({"x86_64": 60, "aarch64": 93}[os.uname().machine], 0)
`

/** `tids` lists threads that have already exited by the time their stat is read. */
type Member = { pid: number; state: string; pgrp: number; tids?: number[] }

/** A `/proc` that moves to the next snapshot each time `/proc` itself is listed, then stays on the last. */
function scriptedProc(snapshots: Member[][]) {
	let passes = 0
	const now = () => snapshots[Math.min(passes, snapshots.length) - 1] ?? []
	const find = (pid: string | undefined) => now().find((m) => String(m.pid) === pid)
	const gone = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	const proc: ProcFs = {
		readdir(path) {
			if (path === "/proc") {
				passes++
				return ["self", ...now().map((m) => String(m.pid))]
			}
			const pid = /^\/proc\/(\d+)\/task$/.exec(path)?.[1]
			const m = find(pid)
			if (!m) throw gone()
			return [pid as string, ...(m.tids ?? []).map(String)]
		},
		readFile(path) {
			const [, pid, tid] = /^\/proc\/(\d+)\/(?:task\/(\d+)\/)?stat$/.exec(path) ?? []
			const m = find(pid)
			if (!m || (tid !== undefined && tid !== pid)) throw gone()
			return `${m.pid} (s h) ${m.state} 1 ${m.pgrp} ${m.pgrp} 0`
		},
	}
	return { proc, passes: () => passes }
}

/** A real group to take the signals while `/proc` is scripted. */
function realGroup() {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
	const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>
	const kill = () => {
		try {
			process.kill(-child.pid!, "SIGKILL")
		} catch {}
	}
	return { pgid: child.pid!, exit, kill }
}

const state = (pid: number) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]
	} catch {
		return undefined
	}
}

describe.skipIf(!proc)("groupAlive", () => {
	it("counts a group whose only member is a zombie nobody has reaped as gone", async () => {
		requireTool("setsid")
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

	it("counts a process whose leader thread exited as running while a worker thread runs", async () => {
		requireTool("python3")
		const child = spawn("python3", ["-c", LONE_WORKER], { detached: true, stdio: ["ignore", "pipe", "inherit"] })
		const pgid = child.pid!
		try {
			await once(child.stdout, "data")
			for (let i = 0; i < 100 && state(pgid) !== "Z"; i++) await sleep(50)
			expect(state(pgid)).toBe("Z")
			expect(groupAlive(pgid)).toBe(true)
			expect(await endGroup(pgid, 2_000)).toBe(true)
		} finally {
			try {
				process.kill(-pgid, "SIGKILL")
			} catch {}
		}
	})

	it("reads a zombie-only pass again, so a member forked behind the first pass still counts", async () => {
		const { pgid, exit, kill } = realGroup()
		try {
			const zombie = { pid: pgid, state: "Z", pgrp: pgid }
			// The second pass lists a member forked after the first pass listed /proc.
			const race = () => scriptedProc([[zombie], [zombie, { pid: 4_000_001, state: "S", pgrp: pgid }]])
			const alive = race()
			expect(groupAlive(pgid, alive.proc)).toBe(true)
			expect(alive.passes()).toBe(2)
			expect(await endGroup(pgid, 2_000, race().proc)).toBe(true)
			const [, signal] = await Promise.race([exit, sleep(1_000).then(() => [null, null] as const)])
			expect(signal).toBe("SIGTERM")
		} finally {
			kill()
		}
	})

	it("stops once two passes list the same members, and counts members or threads that change on every pass as running", () => {
		const { pgid, kill } = realGroup()
		try {
			const zombie = (pid: number, tids?: number[]) => ({ pid, state: "Z", pgrp: pgid, tids })
			expect(groupAlive(pgid, scriptedProc([[zombie(pgid)]]).proc)).toBe(false)
			// The same two members, listed in a different order on every pass.
			const reordered = Array.from({ length: 20 }, (_, i) =>
				i % 2 ? [zombie(pgid), zombie(4_000_001)] : [zombie(4_000_001), zombie(pgid)],
			)
			expect(groupAlive(pgid, scriptedProc(reordered).proc)).toBe(false)
			const churn = scriptedProc(Array.from({ length: 20 }, (_, i) => [zombie(pgid), zombie(4_000_001 + i)]))
			expect(groupAlive(pgid, churn.proc)).toBe(true)
			expect(churn.passes()).toBeLessThan(20)
			// Each pass lists a thread that started another and exited before its stat was read.
			const handoff = scriptedProc(Array.from({ length: 20 }, (_, i) => [zombie(pgid, [4_100_001 + i])]))
			expect(groupAlive(pgid, handoff.proc)).toBe(true)
		} finally {
			kill()
		}
	})
})

describe.skipIf(!proc)("startTime and pidNamespace", () => {
	it("names a process by its start while /proc lists it, a zombie included, and nothing once it is reaped", async () => {
		// `sleep 30` replaces the shell and never reaps the short sleep, which stays a zombie.
		const parent = spawn("sh", ["-c", "sleep 0.3 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "inherit"] })
		try {
			const [chunk] = (await once(parent.stdout, "data")) as [Buffer]
			const pid = Number(chunk.toString().trim())
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
			const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
			expect(startTime(pid)).toBe(start)
			expect(startTime(pid)).not.toBe(startTime(process.pid))
			for (let i = 0; i < 100 && state(pid) !== "Z"; i++) await sleep(50)
			expect(state(pid)).toBe("Z")
			expect(startTime(pid)).toBe(start)
		} finally {
			parent.kill("SIGKILL")
		}
		const reaped = spawn("true")
		await once(reaped, "exit")
		expect(startTime(reaped.pid as number)).toBeUndefined()
	})

	it("gives no token where /proc numbers another pid namespace or hides pids", () => {
		const mounted = (...options: string[]) => options.map((o) => `25 1 0:5 / /proc rw,nosuid - proc proc ${o}\n`).join("")
		const scripted = (nspid: string, mountinfo: string): ProcLinks => ({
			readdir: () => [],
			readFile: (path) =>
				path.endsWith("mountinfo") ? mountinfo : path.endsWith("status") ? `Pid:\t1\nNSpid:\t${nspid}\n` : "boot\n",
			readlink: () => "pid:[1]",
			exists: () => false,
		})
		const own = String(process.pid)
		expect(pidNamespace(scripted(own, mounted("rw")))).toBe("boot/pid:[1]/")
		expect(pidNamespace(scripted(own, mounted("rw,hidepid=0")))).toBe("boot/pid:[1]/")
		expect(pidNamespace(scripted(`7\t${own}`, mounted("rw"))), "an ancestor namespace's /proc").toBeUndefined()
		expect(pidNamespace(scripted(`${own}\t${own}`, mounted("rw"))), "equal pids at two levels").toBeUndefined()
		expect(pidNamespace(scripted(own, mounted("rw,hidepid=invisible")))).toBeUndefined()
		expect(pidNamespace(scripted(own, mounted("rw,hidepid=2,gid=1")))).toBeUndefined()
		expect(pidNamespace(scripted(own, mounted("rw", "rw,hidepid=2"))), "a hidepid overmount").toBeUndefined()
		expect(pidNamespace(scripted(own, mounted("rw,hidepid=2", "rw")))).toBe("boot/pid:[1]/")
	})

	// A host whose /proc the guard refuses (hidepid, an ancestor's /proc) gives no token; CI's runners must.
	it.skipIf(pidNamespace() === undefined && process.env.CI === undefined)(
		"names this boot, pid namespace and time namespace in its token",
		() => {
			const time = existsSync("/proc/self/ns/time") ? readlinkSync("/proc/self/ns/time") : ""
			expect(pidNamespace()).toBe(
				`${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}/${readlinkSync("/proc/self/ns/pid")}/${time}`,
			)
		},
	)
})
